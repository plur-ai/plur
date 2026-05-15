#!/usr/bin/env python3
"""H005 E1 cohort aggregation script.

Reads /var/lib/plur-heartbeat/*.jsonl, derives cohort-1 install dates,
computes per-install engagement metrics, and writes three readout artifacts:
  cohort.csv, metrics.json, summary.md

Usage:
    python3 aggregate.py --data-dir /var/lib/plur-heartbeat \
                         --out-dir /var/lib/plur-heartbeat/readouts/h005-e1-$(date +%Y-%m-%d)

Cohort-1 window: [2026-05-14, 2026-06-13)
"""

import argparse
import csv
import json
import pathlib
import statistics
import sys
from collections import defaultdict
from datetime import date, timedelta

COHORT_START = date(2026, 5, 14)
COHORT_END   = date(2026, 6, 13)  # exclusive

VALIDATE_MEDIAN_DAYS   = 1.5
VALIDATE_W4_RETENTION  = 0.30
INVALIDATE_W4_RETENTION = 0.10
INVALIDATE_MEDIAN_DAYS  = 0.50
STRETCH_W4_RETENTION    = 0.50

REQUIRED_FIELDS = {"install_id", "version", "platform", "date",
                   "learn_count", "recall_count", "session_count"}


def _parse_date(s: str) -> date:
    return date.fromisoformat(s)


def load_corpus(data_dir: pathlib.Path) -> dict:
    """Return dict keyed by install_id, value = list of day-records."""
    by_install: dict[str, list[dict]] = defaultdict(list)
    for path in sorted(data_dir.glob("*.jsonl")):
        with path.open() as fh:
            for lineno, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    print(f"WARN: {path.name}:{lineno} — invalid JSON, skipped", file=sys.stderr)
                    continue
                if not REQUIRED_FIELDS.issubset(rec):
                    print(f"WARN: {path.name}:{lineno} — missing fields, skipped", file=sys.stderr)
                    continue
                rec["date"] = _parse_date(rec["date"])
                by_install[rec["install_id"]].append(rec)
    return by_install


def derive_cohort(by_install: dict) -> dict:
    """Filter to cohort-1: install_date in [COHORT_START, COHORT_END)."""
    cohort = {}
    for iid, records in by_install.items():
        install_date = min(r["date"] for r in records)
        if COHORT_START <= install_date < COHORT_END:
            cohort[iid] = {"install_date": install_date, "records": records}
    return cohort


def _week_bounds(install_date: date, week: int) -> tuple[date, date]:
    """Return [start, end) for week k (1-indexed)."""
    start = install_date + timedelta(days=7 * (week - 1))
    end   = install_date + timedelta(days=7 * week)
    return start, end


def _active_days_in_week(records: list, install_date: date, week: int) -> int:
    """Count distinct active dates in the given week window.

    A day counts as active if it has any learn, recall, or session event.
    """
    start, end = _week_bounds(install_date, week)
    active = set()
    for r in records:
        if start <= r["date"] < end:
            if r["learn_count"] + r["recall_count"] + r["session_count"] > 0:
                active.add(r["date"])
    return len(active)


def _week4_engaged(records: list, install_date: date) -> bool:
    """True if ≥1 learn or recall event in week 4 (engagement, not just presence)."""
    start, end = _week_bounds(install_date, 4)
    for r in records:
        if start <= r["date"] < end:
            if r["learn_count"] + r["recall_count"] > 0:
                return True
    return False


def compute_install_metrics(cohort: dict) -> list[dict]:
    rows = []
    for iid, data in cohort.items():
        install_date = data["install_date"]
        records = data["records"]
        w = [_active_days_in_week(records, install_date, k) for k in range(1, 5)]
        rows.append({
            "install_id":        iid,
            "install_date":      install_date.isoformat(),
            "platform":          records[0]["platform"],
            "version_at_install": sorted(records, key=lambda r: r["date"])[0]["version"],
            "active_days_w1":    w[0],
            "active_days_w2":    w[1],
            "active_days_w3":    w[2],
            "active_days_w4":    w[3],
            "learn_total":       sum(r["learn_count"] for r in records),
            "recall_total":      sum(r["recall_count"] for r in records),
            "week4_active":      _week4_engaged(records, install_date),
        })
    return rows


def compute_cohort_metrics(rows: list[dict]) -> dict:
    n = len(rows)
    if n == 0:
        return {
            "cohort_size": 0,
            "median_active_days_per_week": 0.0,
            "week4_retention_pct": 0.0,
            "validates_h005": False,
            "invalidates_h005": True,
            "verdict": "invalidate",
            "platform_breakdown": {},
            "version_breakdown": {},
        }

    active_per_week = [
        (r["active_days_w1"] + r["active_days_w2"] +
         r["active_days_w3"] + r["active_days_w4"]) / 4.0
        for r in rows
    ]
    median_apw = statistics.median(active_per_week)
    w4_count = sum(1 for r in rows if r["week4_active"])
    w4_pct = w4_count / n

    validates   = median_apw >= VALIDATE_MEDIAN_DAYS and w4_pct >= VALIDATE_W4_RETENTION
    invalidates = w4_pct < INVALIDATE_W4_RETENTION or median_apw < INVALIDATE_MEDIAN_DAYS

    if validates:
        verdict = "validate"
    elif invalidates:
        verdict = "invalidate"
    else:
        verdict = "inconclusive"

    platforms = defaultdict(int)
    versions  = defaultdict(int)
    for r in rows:
        platforms[r["platform"]] += 1
        versions[r["version_at_install"]] += 1

    return {
        "cohort_size":                n,
        "median_active_days_per_week": round(median_apw, 4),
        "week4_retention_pct":         round(w4_pct, 4),
        "validates_h005":              validates,
        "invalidates_h005":            invalidates,
        "verdict":                     verdict,
        "platform_breakdown":          dict(platforms),
        "version_breakdown":           dict(versions),
    }


def write_cohort_csv(rows: list[dict], out_dir: pathlib.Path) -> None:
    path = out_dir / "cohort.csv"
    if not rows:
        path.write_text("")
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def write_metrics_json(metrics: dict, out_dir: pathlib.Path) -> None:
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))


def write_summary_md(metrics: dict, out_dir: pathlib.Path, run_date: str) -> None:
    n          = metrics["cohort_size"]
    median_apw = metrics["median_active_days_per_week"]
    w4_pct     = metrics["week4_retention_pct"]
    verdict    = metrics["verdict"].upper()
    validates  = metrics["validates_h005"]
    invalidates = metrics["invalidates_h005"]

    verdict_emoji = {"VALIDATE": "✅", "INVALIDATE": "❌", "INCONCLUSIVE": "⚠️"}.get(verdict, "")

    platform_lines = "\n".join(
        f"- {k}: {v}" for k, v in sorted(metrics["platform_breakdown"].items())
    )
    version_lines = "\n".join(
        f"- {k}: {v}" for k, v in sorted(metrics["version_breakdown"].items())
    )

    summary = f"""# H005 E1 Readout — Cohort-1 Engagement Baseline
Generated: {run_date}

## Verdict: {verdict_emoji} {verdict}

| Metric | Value | Threshold |
|--------|-------|-----------|
| Cohort size | {n} | — |
| Median active-days/week | {median_apw:.2f} | ≥ 1.5 to validate |
| Week-4 retention | {w4_pct * 100:.1f}% | ≥ 30% to validate / < 10% to invalidate |

**Validates H005:** {"Yes" if validates else "No"}
**Invalidates H005:** {"Yes" if invalidates else "No"}

## Interpretation

{"H005 confirmed: Hermes-channel installs convert to sustained engagement. Cohort-1 meets both the median active-days and week-4 retention floor. The Hermes channel ROI thesis is supported." if validates else ""}
{"H005 falsified: install-and-forget pattern detected. Week-4 retention or median engagement is below the anti-metric floor. The Hermes channel needs diagnosis before further investment." if invalidates else ""}
{"H005 inconclusive: cohort-1 is above the invalidation floor but below the validation threshold. More data (cohort-2 or extended window) needed before a decision." if not validates and not invalidates else ""}

## Platform Breakdown

{platform_lines if platform_lines else "— no data —"}

## Version Breakdown

{version_lines if version_lines else "— no data —"}

## Notes

- Cohort-1 window: {COHORT_START.isoformat()} – {COHORT_END.isoformat()} (install_date derived from earliest observed heartbeat)
- Active-day: any date with learn_count + recall_count + session_count > 0
- Week-4 engaged: ≥1 learn or recall event in install_date + [21d, 28d)
- Stretch target (≥50% W4 retention): {"MET" if w4_pct >= STRETCH_W4_RETENTION else "not met"}
"""
    (out_dir / "summary.md").write_text(summary)


def main(argv=None):
    parser = argparse.ArgumentParser(description="H005 E1 cohort aggregation")
    parser.add_argument("--data-dir",  default="/var/lib/plur-heartbeat",
                        help="Directory containing YYYY-MM-DD.jsonl files")
    parser.add_argument("--out-dir",   required=True,
                        help="Output directory for readout artifacts")
    parser.add_argument("--run-date",  default=date.today().isoformat(),
                        help="Date label for summary (default: today)")
    args = parser.parse_args(argv)

    data_dir = pathlib.Path(args.data_dir)
    out_dir  = pathlib.Path(args.out_dir)

    if not data_dir.is_dir():
        print(f"ERROR: data-dir {data_dir} does not exist", file=sys.stderr)
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)

    by_install = load_corpus(data_dir)
    cohort     = derive_cohort(by_install)
    rows       = compute_install_metrics(cohort)
    metrics    = compute_cohort_metrics(rows)

    write_cohort_csv(rows, out_dir)
    write_metrics_json(metrics, out_dir)
    write_summary_md(metrics, out_dir, args.run_date)

    print(f"Cohort size: {metrics['cohort_size']}")
    print(f"Median active-days/week: {metrics['median_active_days_per_week']}")
    print(f"Week-4 retention: {metrics['week4_retention_pct']*100:.1f}%")
    print(f"Verdict: {metrics['verdict'].upper()}")
    print(f"Artifacts written to: {out_dir}")


if __name__ == "__main__":
    main()
