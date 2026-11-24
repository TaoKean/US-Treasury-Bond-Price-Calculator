// Run with:  node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const P = require("../js/pricing.js");

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + b + ", got " + a);
const dayN = (iso) => P.parseISODate(iso).n;

// Build a one-row dataset. Flat 5% curve unless overridden.
function ds(date, over) {
  const row = Object.assign(
    { date, beta0: 5, beta1: 0, beta2: 0, beta3: 0, tau1: 1, tau2: -999.99, maxTenor: 30 }, over || {});
  return { rows: new Map([[date, row]]) };
}
const price = (d, s, m, c) => P.priceBond({ dataset: d, settlement: s, maturity: m, couponPct: c });

test("dates are validated as real calendar dates", () => {
  assert.equal(P.parseISODate("2027-02-29"), null);
  assert.equal(P.parseISODate("2028-02-29").d, 29);
  assert.equal(P.parseISODate("2026-13-01"), null);
  assert.equal(P.dayNumberToISO(dayN("2026-03-08") + 1), "2026-03-09"); // US DST change: no skipped day
});

test("coupon dates anchor to maturity (month-end does not drift)", () => {
  const mat = P.parseISODate("2030-08-31");
  const got = [0, 1, 2, 3, 4, 5, 6].map((k) => P.dayNumberToISO(P.shiftMonthsBack(mat, 6 * k)));
  assert.deepEqual(got, ["2030-08-31", "2030-02-28", "2029-08-31", "2029-02-28", "2028-08-31", "2028-02-29", "2027-08-31"]);
});

test("spot curve: A(x), B(x), BETA3 omission", () => {
  near(P.A(1e-12), 1, 1e-12);
  near(P.A(1e-5), (1 - Math.exp(-1e-5)) / 1e-5, 1e-12);
  near(P.B(2), P.A(2) - Math.exp(-2), 1e-15);
  const p3 = { beta0: 3, beta1: 1, beta2: -2, beta3: 0, tau1: 1.5, tau2: -999.99 };
  const expect = (3 + 1 * P.A(4 / 1.5) - 2 * P.B(4 / 1.5)) / 100;
  near(P.spotRate(p3, 4), expect, 1e-15);
  const p4 = Object.assign({}, p3, { beta3: 2, tau2: 9 });
  near(P.spotRate(p4, 4), expect + 2 * P.B(4 / 9) / 100, 1e-15);
});

test("curve parameter validation depends on active terms", () => {
  assert.deepEqual(P.validateCurveParams({ beta0: 1, beta1: 1, beta2: 1, beta3: 0, tau1: 1, tau2: -999.99 }), []);
  assert.deepEqual(P.validateCurveParams({ beta0: 1, beta1: 1, beta2: 1, beta3: 1, tau1: 1, tau2: -999.99 }), ["TAU2"]);
  assert.deepEqual(P.validateCurveParams({ beta0: NaN, beta1: 1, beta2: 1, beta3: 0, tau1: 0, tau2: 1 }), ["BETA0", "TAU1"]);
});

test("zero coupon bond on a flat curve: price = 100 * exp(-r t)", () => {
  const r = price(ds("2026-11-13"), "2026-11-13", "2029-11-13", 0);
  assert.ok(r.ok);
  const t = (dayN("2029-11-13") - dayN("2026-11-13")) / 365;
  near(r.dirty, 100 * Math.exp(-0.05 * t), 1e-10);
  assert.equal(r.accrued, 0);
  assert.equal(r.flows.length, 6);
  near(r.flows[5].cashFlow, 100, 0);
});

test("fractional-year maturity matches an independent calculation", () => {
  const set = "2026-11-13", mat = "2031-04-20", c = 4.25;
  const r = price(ds(set), set, mat, c);
  assert.ok(r.ok);
  // coupon dates: 2031-04-20, 2030-10-20, ... first after settlement is 2027-04-20
  const exp = [];
  for (let y = 2027, m = 4; ; ) {
    exp.push(Date.UTC(y, m - 1, 20) / 864e5);
    if (y === 2031 && m === 4) break;
    m += 6; if (m > 12) { m -= 12; y++; }
  }
  assert.equal(r.flows.length, exp.length);
  let dirty = 0;
  exp.forEach((n, i) => {
    const t = (n - dayN(set)) / 365;
    const cf = 2.125 + (i === exp.length - 1 ? 100 : 0);
    dirty += cf * Math.exp(-0.05 * t);
    near(r.flows[i].t, t, 1e-12);
  });
  near(r.dirty, dirty, 1e-9);
  // accrued: previous 2026-10-20, next 2027-04-20
  const prev = dayN("2026-10-20"), next = dayN("2027-04-20"), s = dayN(set);
  near(r.accrued, 2.125 * (s - prev) / (next - prev), 1e-12);
  assert.equal(r.previousCoupon, "2026-10-20");
  assert.equal(r.nextCoupon, "2027-04-20");
  near(r.clean, r.dirty - r.accrued, 1e-12);
});

test("settlement on a coupon date: coupon excluded, accrued is zero", () => {
  const r = price(ds("2027-11-15"), "2027-11-15", "2030-05-15", 4);
  assert.ok(r.ok);
  assert.equal(r.flows[0].date, "2028-05-15");
  assert.equal(r.flows.length, 5);
  assert.equal(r.accrued, 0);
  near(r.clean, r.dirty, 0);
});

test("month-end maturity schedule in a full pricing run", () => {
  const r = price(ds("2026-11-13"), "2026-11-13", "2028-08-31", 3);
  assert.deepEqual(r.flows.map((f) => f.date),
    ["2027-02-28", "2027-08-31", "2028-02-29", "2028-08-31"]);
  assert.equal(r.previousCoupon, "2026-08-31");
});

test("BETA3 = 0 row with TAU2 = -999.99 prices fine", () => {
  const d = ds("1975-01-02", { beta0: 6, beta1: -1, beta2: 1, tau1: 0.5 });
  const r = price(d, "1975-01-02", "1980-01-02", 7);
  assert.ok(r.ok);
  assert.ok(isFinite(r.clean) && r.clean > 0);
});

test("BETA3 nonzero uses TAU2", () => {
  const d = ds("2020-01-02", { beta0: 2, beta1: 1, beta2: 1, beta3: 3, tau1: 2, tau2: 8 });
  const r = price(d, "2020-01-02", "2025-01-02", 0);
  const t = r.flows[r.flows.length - 1].t;
  near(r.flows[r.flows.length - 1].spot, (2 + P.A(t / 2) + P.B(t / 2) + 3 * P.B(t / 8)) / 100, 1e-14);
});

test("validation messages", () => {
  const d = ds("2026-11-13", { maxTenor: 10 });
  assert.equal(price(d, "2026-11-14", "2030-01-01", 4).code, "date-unavailable");
  assert.equal(price(d, "", "2030-01-01", 4).code, "settlement-invalid");
  assert.equal(price(d, "2026-11-13", "", 4).code, "maturity-invalid");
  assert.equal(price(d, "2026-11-13", "2026-11-13", 4).code, "maturity-not-after");
  assert.equal(price(d, "2026-11-13", "2026-01-01", 4).code, "maturity-not-after");
  assert.equal(price(d, "2026-11-13", "2030-01-01", -1).code, "coupon-invalid");
  assert.equal(price(d, "2026-11-13", "2030-01-01", "").code, "coupon-invalid");
  assert.equal(price(d, "2026-11-13", "2030-01-01", "abc").code, "coupon-invalid");
  assert.equal(price(d, "2026-11-13", "2030-01-01", Infinity).code, "coupon-invalid");
  assert.equal(price(d, "2026-11-13", "2037-01-01", 4).code, "beyond-coverage");
  assert.ok(price(d, "2026-11-13", "2036-11-10", 4).ok); // 3649 days = 9.997 years, inside the 10-year limit
});

test("coverage limit compares actual/365 years to the longest tenor", () => {
  const d = ds("2026-11-13", { maxTenor: 7 });
  const limitDay = dayN("2026-11-13") + 7 * 365;
  assert.ok(price(d, "2026-11-13", P.dayNumberToISO(limitDay), 4).ok);
  assert.equal(price(d, "2026-11-13", P.dayNumberToISO(limitDay + 1), 4).code, "beyond-coverage");
});

test("CSV parser skips preamble, treats NA as missing, drops unusable rows", () => {
  const sv = (n) => Array.from({ length: 30 }, (_, i) => (i < n ? "1.5" : "NA")).join(",");
  const header = "Date,BETA0,BETA1,BETA2,BETA3,TAU1,TAU2," + Array.from({ length: 30 }, (_, i) => "SVENY" + String(i + 1).padStart(2, "0")).join(",");
  const text = [
    "\"Note: explanatory text, with commas\"", "", "Series,Convention", "Zero-coupon yield,Continuous", "", header,
    "1961-06-14,3.9,-1.2,-1.9,0,0.33,-999.99," + sv(7),       // kept, BETA3 = 0
    "1961-06-15,NA,NA,NA,NA,NA,NA," + sv(0),                 // dropped (NA)
    "1990-01-02,3,1,1,2,1,NA," + sv(30),                      // dropped (BETA3 != 0, TAU2 NA)
    "1990-01-03,3,1,1,2,1,5," + sv(0),                        // dropped (no SVENY)
    "1990-01-04,3,1,1,2,1,5," + sv(10),                       // kept
    ""
  ].join("\r\n");
  const out = P.parseCurveCSV(text);
  assert.equal(out.total, 5);
  assert.equal(out.dropped, 3);
  assert.deepEqual([...out.rows.keys()], ["1961-06-14", "1990-01-04"]);
  assert.equal(out.rows.get("1961-06-14").maxTenor, 7);
  assert.equal(out.rows.get("1990-01-04").maxTenor, 10);
  assert.throws(() => P.parseCurveCSV("a,b\n1,2"), /Date,/);
});

// ---- Checks against the shipped dataset ----
const cleanPath = path.join(__dirname, "..", "data", "yields_clean.csv");
if (fs.existsSync(cleanPath)) {
  const data = P.parseCurveCSV(fs.readFileSync(cleanPath, "utf8"));
  const raw = fs.readFileSync(cleanPath, "utf8").split("\n");
  const header = raw[0].split(",");

  test("shipped dataset loads with no unusable rows", () => {
    assert.ok(data.rows.size > 16000);
    assert.equal(data.dropped, 0);
  });

  test("fitted spot rates reproduce the published SVENYxx columns (all eras)", () => {
    const dates = ["1961-06-14", "1975-03-03", "1979-12-31", "1980-01-02", "1995-07-17", "2008-10-10", "2019-12-31", "2026-11-13"];
    const byDate = new Map(raw.slice(1).filter(Boolean).map((l) => [l.slice(0, 10), l.split(",")]));
    for (const dt of dates) {
      const row = data.rows.get(dt), f = byDate.get(dt);
      assert.ok(row, dt + " missing");
      let checked = 0;
      for (let k = 1; k <= 30; k++) {
        const v = Number(f[header.indexOf("SVENY" + String(k).padStart(2, "0"))]);
        if (!isFinite(v)) continue;
        near(P.spotRate(row, k) * 100, v, 6e-5, dt + " SVENY" + k);
        checked++;
      }
      assert.equal(checked, row.maxTenor >= 1 ? checked : 0);
      assert.ok(checked > 0);
    }
  });

  test("a real-date pricing run is sane", () => {
    const r = price(data, "2026-11-13", "2036-11-15", 4.25);
    assert.ok(r.ok);
    assert.ok(r.dirty > 50 && r.dirty < 150);
    near(r.clean, r.dirty - r.accrued, 1e-12);
    const sumPV = r.flows.reduce((a, f) => a + f.pv, 0);
    near(sumPV, r.dirty, 1e-10);
  });
}
