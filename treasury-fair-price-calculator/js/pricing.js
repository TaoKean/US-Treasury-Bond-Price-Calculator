/*
 * Pricing engine and CSV loader for the U.S. Treasury Fair Price Calculator.
 * Plain JavaScript, no dependencies. Runs in the browser (window.TreasuryPricer)
 * and in Node (module.exports) so the same code is unit-tested.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TreasuryPricer = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MS_PER_DAY = 86400000;
  var FACE = 100;
  var MAX_TENOR_COLS = 30;

  /* ---------- calendar dates (pure day numbers, no time zones) ---------- */

  function daysInMonth(y, m) { // m is 1-12
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  // "YYYY-MM-DD" -> {y, m, d, n}, n = days since 1970-01-01. null if invalid.
  function parseISODate(text) {
    var mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text == null ? "" : text).trim());
    if (!mt) return null;
    var y = +mt[1], m = +mt[2], d = +mt[3];
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y: y, m: m, d: d, n: Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY) };
  }

  function dayNumberToISO(n) {
    var dt = new Date(n * MS_PER_DAY);
    var y = dt.getUTCFullYear();
    var ys = y < 0 ? String(y) : ("000" + y).slice(-4);
    return ys + "-" + ("0" + (dt.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + dt.getUTCDate()).slice(-2);
  }

  // Maturity date minus `months`, always counted from the original maturity,
  // clamped to the last day of the target month (Aug 31 -> Feb 28/29 -> Aug 31).
  function shiftMonthsBack(mat, months) {
    var idx = mat.y * 12 + (mat.m - 1) - months;
    var y = Math.floor(idx / 12), m = idx - y * 12 + 1;
    var d = Math.min(mat.d, daysInMonth(y, m));
    return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
  }

  /* ---------- Svensson curve ---------- */

  function A(x) { // (1 - e^-x) / x, safe at x -> 0
    if (Math.abs(x) < 1e-8) return 1 - x / 2;
    return -Math.expm1(-x) / x;
  }
  function B(x) { return A(x) - Math.exp(-x); }

  // Continuously compounded spot rate, decimal (0.045 = 4.5%).
  // The BETA3 term is left out entirely when BETA3 is zero.
  function spotRate(p, t) {
    var s = p.beta0 + p.beta1 * A(t / p.tau1) + p.beta2 * B(t / p.tau1);
    if (p.beta3 !== 0) s += p.beta3 * B(t / p.tau2);
    return s / 100;
  }

  // Returns a list of problems with the curve parameters (empty = usable).
  function validateCurveParams(p) {
    var bad = [];
    function fin(v) { return typeof v === "number" && isFinite(v); }
    if (!fin(p.beta0)) bad.push("BETA0");
    if (!fin(p.beta1)) bad.push("BETA1");
    if (!fin(p.beta2)) bad.push("BETA2");
    if (!fin(p.tau1) || p.tau1 <= 0) bad.push("TAU1");
    if (!fin(p.beta3)) bad.push("BETA3");
    else if (p.beta3 !== 0 && (!fin(p.tau2) || p.tau2 <= 0)) bad.push("TAU2");
    return bad;
  }

  /* ---------- CSV ---------- */

  function toNumber(s) { // "NA", blank or junk -> NaN
    if (s == null) return NaN;
    s = String(s).trim();
    if (s === "" || s.toUpperCase() === "NA") return NaN;
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  }

  // Parses the Federal Reserve file (explanatory text on top) or the cleaned file.
  // Returns { rows: Map(date -> row), total, dropped, firstDate, lastDate }.
  function parseCurveCSV(text) {
    text = String(text).replace(/^\uFEFF/, "");
    var lines = text.split(/\r\n|\n|\r/);
    var h = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("Date,") === 0) { h = i; break; }
    }
    if (h < 0) throw new Error("No header row beginning with \"Date,\" was found in this file.");

    var cols = lines[h].split(",").map(function (c) { return c.trim(); });
    var idx = {};
    cols.forEach(function (c, k) { idx[c] = k; });
    var need = ["Date", "BETA0", "BETA1", "BETA2", "BETA3", "TAU1", "TAU2", "SVENY01"];
    var miss = need.filter(function (c) { return !(c in idx); });
    if (miss.length) throw new Error("The file is missing required columns: " + miss.join(", ") + ".");

    var tenorIdx = [];
    for (var k = 1; k <= MAX_TENOR_COLS; k++) {
      var name = "SVENY" + (k < 10 ? "0" + k : k);
      tenorIdx.push(name in idx ? idx[name] : -1);
    }

    var rows = new Map(), total = 0, dropped = 0, first = null, last = null;
    for (var r = h + 1; r < lines.length; r++) {
      var line = lines[r];
      if (!line || !line.trim()) continue;
      var f = line.split(",");
      var date = (f[idx.Date] || "").trim();
      if (!parseISODate(date)) continue;
      total++;
      var row = {
        date: date,
        beta0: toNumber(f[idx.BETA0]), beta1: toNumber(f[idx.BETA1]),
        beta2: toNumber(f[idx.BETA2]), beta3: toNumber(f[idx.BETA3]),
        tau1: toNumber(f[idx.TAU1]), tau2: toNumber(f[idx.TAU2]),
        maxTenor: 0
      };
      for (var j = MAX_TENOR_COLS; j >= 1; j--) {
        var ti = tenorIdx[j - 1];
        if (ti >= 0 && isFinite(toNumber(f[ti]))) { row.maxTenor = j; break; }
      }
      if (validateCurveParams(row).length || row.maxTenor === 0) { dropped++; continue; }
      rows.set(date, row);
      if (first === null || date < first) first = date;
      if (last === null || date > last) last = date;
    }
    return { rows: rows, total: total, dropped: dropped, firstDate: first, lastDate: last };
  }

  /* ---------- pricing ---------- */

  function fail(code, message) { return { ok: false, code: code, message: message }; }

  // opts: { dataset, settlement: "YYYY-MM-DD", maturity: "YYYY-MM-DD", couponPct: number|string }
  function priceBond(opts) {
    var dataset = opts.dataset;
    var set = parseISODate(opts.settlement);
    if (!set) return fail("settlement-invalid", "Enter a valid valuation date.");
    var row = dataset && dataset.rows.get(opts.settlement);
    if (!row) {
      return fail("date-unavailable",
        "The valuation date " + opts.settlement + " is not available in the loaded dataset " +
        "(weekends, holidays and dates with incomplete curve data are not included).");
    }
    var bad = validateCurveParams(row);
    if (bad.length) return fail("curve-unusable", "The curve row for " + row.date + " has unusable parameters: " + bad.join(", ") + ".");

    var mat = parseISODate(opts.maturity);
    if (!mat) return fail("maturity-invalid", "Enter a valid maturity date.");
    if (mat.n <= set.n) return fail("maturity-not-after", "The maturity date must be after the valuation date.");

    var cStr = String(opts.couponPct == null ? "" : opts.couponPct).trim();
    var cPct = cStr === "" ? NaN : Number(cStr);
    if (!isFinite(cPct) || cPct < 0) return fail("coupon-invalid", "The coupon rate must be a number that is zero or greater.");

    var tMat = (mat.n - set.n) / 365;
    if (tMat > row.maxTenor) {
      return fail("beyond-coverage",
        "The maturity date is " + tMat.toFixed(2) + " years after the valuation date, but the curve published for " +
        row.date + " only covers maturities up to " + row.maxTenor + " years.");
    }

    var c = cPct / 100;
    var coupon = FACE * c / 2;

    // Coupon dates counted back from maturity until we reach settlement or earlier.
    var dates = [], k = 0, dk;
    while (true) {
      dk = shiftMonthsBack(mat, 6 * k);
      if (dk <= set.n) break;
      dates.push(dk);
      k++;
    }
    var prev = dk;                                   // last coupon date on/before settlement
    var next = dates[dates.length - 1];              // first coupon date after settlement
    dates.reverse();

    var flows = [], dirty = 0;
    for (var i = 0; i < dates.length; i++) {
      var days = dates[i] - set.n;
      var t = days / 365;
      var cf = coupon + (i === dates.length - 1 ? FACE : 0);
      var z = spotRate(row, t);
      var df = Math.exp(-z * t);
      var pv = cf * df;
      dirty += pv;
      flows.push({ date: dayNumberToISO(dates[i]), days: days, t: t, cashFlow: cf, spot: z, df: df, pv: pv });
    }

    var accrued = prev === set.n ? 0 : coupon * (set.n - prev) / (next - prev);

    return {
      ok: true,
      row: row,
      settlement: opts.settlement,
      maturity: opts.maturity,
      couponPct: cPct,
      couponPayment: coupon,
      yearsToMaturity: tMat,
      maxTenor: row.maxTenor,
      previousCoupon: dayNumberToISO(prev),
      nextCoupon: dayNumberToISO(next),
      flows: flows,
      dirty: dirty,
      accrued: accrued,
      clean: dirty - accrued
    };
  }

  return {
    FACE: FACE,
    parseISODate: parseISODate,
    dayNumberToISO: dayNumberToISO,
    shiftMonthsBack: shiftMonthsBack,
    A: A, B: B,
    spotRate: spotRate,
    validateCurveParams: validateCurveParams,
    parseCurveCSV: parseCurveCSV,
    priceBond: priceBond
  };
});
