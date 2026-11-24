# U.S. Treasury Fair Price Calculator

A coursework prototype that estimates the model-implied fair price of a regular, semiannual, fixed-rate U.S. Treasury note or bond. It discounts each cash flow on the **Federal Reserve fitted nominal Treasury curve**. It runs entirely in the browser: no backend, no API key, no build step.

## What you enter

1. **Valuation date** (treated as the settlement date). It must be a date in the dataset.
2. **Maturity date** (any exact date, so fractional years work).
3. **Annual coupon rate (%)**, for example `4.25`.

Face value is $100. There is no market price input. The page shows the model clean price (main result), the model dirty price, accrued interest, a chart of where the bond sits on the fitted spot curve, and an expandable cash-flow table.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The calculator page (styles and UI code inline). |
| `js/pricing.js` | Pricing engine and CSV parser. Used by the page and by the tests. |
| `data/yields_clean.csv` | Cleaned dataset the page loads on start. |
| `tools/prepare_data.py` | Rebuilds `data/yields_clean.csv` from the original Federal Reserve CSV. |
| `tests/pricing.test.js` | Unit tests for the engine and the dataset. |
| `.nojekyll` | Tells GitHub Pages to serve files as they are. |

## Open it locally

The page fetches `data/yields_clean.csv`, and browsers block that when you double-click `index.html` (a `file://` page). Two easy options:

- **Local server (recommended).** From this folder run `python3 -m http.server 8000`, then open <http://localhost:8000>.
- **Upload.** Double-click `index.html`. The page will say the dataset could not be loaded and open the **Data source** section. Choose `data/yields_clean.csv` (or the original Federal Reserve CSV) there. The file stays in your browser.

## Publish on GitHub Pages

1. Create a GitHub repository and upload everything in this folder, keeping the folder structure (including the hidden `.nojekyll` file).
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select your main branch and the `/ (root)` folder, and save.
4. After a minute, the page is live at `https://<your-username>.github.io/<repository-name>/`. The dataset loads automatically because `data/yields_clean.csv` is served from the same site.

`data/yields_clean.csv` is about 6.5 MB (roughly 2.5 MB when compressed in transit), which is well inside GitHub’s limits.

## Data cleaning

The original file has explanatory text above the table, so the loader (and the script) start at the header row that begins with `Date,`. `NA` is treated as missing.

`tools/prepare_data.py` keeps `Date`, `BETA0`–`BETA3`, `TAU1`, `TAU2` and `SVENY01`–`SVENY30`, with values copied as text so nothing is rounded. It drops a row when:

- `BETA0`, `BETA1`, `BETA2` or `TAU1` is missing, or `TAU1` is not positive;
- `BETA3` is missing, or `BETA3` is nonzero while `TAU2` is missing or not positive;
- every `SVENY` tenor is missing, so there is no coverage limit.

A missing `SVENY` value on an otherwise usable row is kept: the longest non-missing tenor on that row is the maximum maturity the page accepts for that date.

Result for the supplied file (`feds200628`):

- 17,068 data rows read, **16,318 kept** (1961-06-14 to 2026-11-13), 750 dropped (749 with missing curve parameters, 1 with no `SVENY` tenor).
- **4,620 kept rows (28.3%) have `BETA3 = 0`**, all on or before 1979-12-31. In those rows `TAU2` is the placeholder `-999.99`, and the calculator leaves the `BETA3` term out. From 1980 onward `BETA3` is nonzero, so the term is used.

To rebuild the file:

```
python3 tools/prepare_data.py path/to/feds200628.csv
```

An optional `--start-date YYYY-MM-DD` removes older rows.

## Pricing method (summary)

- Coupon `C = 100 × coupon / 2`. Coupon dates are counted back from maturity in six-month steps, always from the maturity date itself, with day clamped to the month’s last day (an Aug 31 maturity gives Feb 28/29, then Aug 31 again). Only payments strictly after settlement count; the last one includes the $100 principal.
- `t = actual calendar days from settlement / 365`. Dates are handled as calendar days, so time zones and daylight-saving changes cannot change a day count.
- `z(t) = [BETA0 + BETA1·A(t/TAU1) + BETA2·B(t/TAU1) + BETA3·B(t/TAU2)] / 100`, with `A(x) = (1 − e^−x)/x` and `B(x) = A(x) − e^−x`. The `BETA3` term is omitted when `BETA3 = 0`.
- `DF = exp(−z·t)`, `PV = cash flow × DF`, dirty price `= ΣPV`.
- Accrued interest `= C × (days from previous coupon to settlement) / (days from previous coupon to next coupon)`, and zero on a coupon date. Clean price `= dirty − accrued`.
- Maturities beyond that date’s longest published tenor are rejected, not extrapolated. Cash flows under one year use the fitted parameters directly.
- Full precision throughout; results are rounded to four decimals only for display (discount factors show six).

## Tests

Requires Node.js 18 or newer.

```
node --test tests/pricing.test.js
```

The tests cover month-end coupon dates, settlement on a coupon date, a zero-coupon bond, a fractional-year maturity checked against an independent calculation, a `BETA3 = 0` row with `TAU2 = -999.99`, coverage limits, input validation, and the CSV parser. They also check that the fitted spot curve reproduces the Federal Reserve’s own published `SVENY01`–`SVENY30` zero-coupon yields (to within the file’s rounding) on dates spanning 1961 to 2026, which confirms the formula and the `BETA3` term against the source data.

## Limits

This is a model value from a fitted curve. It will not match actual market quotes exactly, and it assumes regular semiannual coupons, settlement equal to the valuation date, and Actual/365 Fixed discounting. It is a coursework prototype, not investment advice.

## Data source

Federal Reserve Board staff nominal Treasury yield curve research data (a staff research product, not an official statistical release).
