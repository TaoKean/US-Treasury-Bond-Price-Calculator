#!/usr/bin/env python3
"""Build data/yields_clean.csv from the Federal Reserve nominal yield curve CSV.

Usage:
    python3 tools/prepare_data.py path/to/feds200628.csv
    python3 tools/prepare_data.py path/to/feds200628.csv -o data/yields_clean.csv
    python3 tools/prepare_data.py path/to/feds200628.csv --start-date 1980-01-01

Only the standard library is used.

Kept columns: Date, BETA0-BETA3, TAU1, TAU2, SVENY01-SVENY30.
Values are copied as text, so no precision is lost. "NA" stays "NA".

A row is dropped when the calculator could not price from it:
  * BETA0, BETA1, BETA2 or TAU1 is missing, or TAU1 <= 0
  * BETA3 is missing
  * BETA3 is nonzero and TAU2 is missing or <= 0
    (when BETA3 = 0 the BETA3 term is omitted, so TAU2 = -999.99 is fine)
  * every SVENY01-SVENY30 value is missing (no curve coverage limit)

A missing SVENY value on an otherwise valid row is kept. Those gaps are how
the app finds the longest published tenor for that date.
"""
import argparse
import csv
import math
import sys
from collections import Counter

SVENY = ["SVENY%02d" % i for i in range(1, 31)]
KEEP = ["Date", "BETA0", "BETA1", "BETA2", "BETA3", "TAU1", "TAU2"] + SVENY


def num(text):
    """Return a finite float, or None for NA / blank / unparsable."""
    if text is None:
        return None
    text = text.strip()
    if text == "" or text.upper() == "NA":
        return None
    try:
        v = float(text)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def drop_reason(row):
    b0, b1, b2, t1 = (num(row[k]) for k in ("BETA0", "BETA1", "BETA2", "TAU1"))
    if None in (b0, b1, b2, t1):
        return "missing BETA0/BETA1/BETA2/TAU1"
    if t1 <= 0:
        return "TAU1 <= 0"
    b3 = num(row["BETA3"])
    if b3 is None:
        return "missing BETA3"
    if b3 != 0:
        t2 = num(row["TAU2"])
        if t2 is None or t2 <= 0:
            return "BETA3 nonzero but TAU2 missing or <= 0"
    if all(num(row[k]) is None for k in SVENY):
        return "no SVENY tenor available"
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="original Federal Reserve CSV (with the explanatory text on top)")
    ap.add_argument("-o", "--output", default="data/yields_clean.csv")
    ap.add_argument("--start-date", help="optional YYYY-MM-DD cutoff; earlier rows are removed")
    args = ap.parse_args()

    with open(args.source, newline="", encoding="utf-8-sig") as fh:
        lines = fh.read().splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.startswith("Date,")), None)
    if start is None:
        sys.exit("No header row beginning with 'Date,' found.")

    reader = csv.DictReader(lines[start:])
    missing_cols = [c for c in KEEP if c not in (reader.fieldnames or [])]
    if missing_cols:
        sys.exit("Source file lacks columns: " + ", ".join(missing_cols))

    kept, dropped, before_cutoff, seen = [], Counter(), 0, set()
    for row in reader:
        date = (row.get("Date") or "").strip()
        if not date:
            continue
        if args.start_date and date < args.start_date:
            before_cutoff += 1
            continue
        if date in seen:
            dropped["duplicate date"] += 1
            continue
        seen.add(date)
        reason = drop_reason(row)
        if reason:
            dropped[reason] += 1
            continue
        kept.append([row[c].strip() for c in KEEP])

    with open(args.output, "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out, lineterminator="\n")
        w.writerow(KEEP)
        w.writerows(kept)

    zero_b3 = [r for r in kept if num(r[4]) == 0]
    print("Wrote %s" % args.output)
    print("  rows kept:    %d (%s to %s)" % (len(kept), kept[0][0], kept[-1][0]))
    print("  rows dropped: %d" % sum(dropped.values()))
    for reason, n in dropped.most_common():
        print("    - %s: %d" % (reason, n))
    if args.start_date:
        print("  rows before --start-date removed: %d" % before_cutoff)
    print("  kept rows with BETA3 = 0: %d (%.1f%%), last on %s" % (
        len(zero_b3), 100.0 * len(zero_b3) / len(kept), zero_b3[-1][0] if zero_b3 else "n/a"))


if __name__ == "__main__":
    main()
