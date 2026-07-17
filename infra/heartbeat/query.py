#!/usr/bin/env python3
"""
plur heartbeat query tool
Usage:
  python3 query.py                  # weekly active count (last 7 days)
  python3 query.py --days 14        # last N days
  python3 query.py --since 2026-07-01  # since a date
  python3 query.py --summary        # full summary stats
  python3 query.py --mau            # north-star MAU/WAU/DAU metric
  python3 query.py --mau --write    # same, but also persist to METRICS_DIR/YYYY-MM-DD.json
                                   #   and update METRICS_DIR/metrics-latest.json pointer

Data lives in /var/lib/plur-heartbeat/YYYY-MM-DD.jsonl (one record per flush).
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(os.environ.get("HEARTBEAT_DATA_DIR", "/var/lib/plur-heartbeat"))
METRICS_DIR = Path(os.environ.get("METRICS_DIR", "/var/lib/plur-metrics"))


def load_records(since: date, until: date) -> list[dict]:
    """Load all records from JSONL files in date range [since, until]."""
    records = []
    current = since
    while current <= until:
        path = DATA_DIR / f"{current.isoformat()}.jsonl"
        if path.exists():
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            records.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        current += timedelta(days=1)
    return records


def weekly_active_count(days: int = 7) -> dict:
    """
    Count distinct install_ids with any activity in the last N days.
    This is the primary H004/H005 metric.
    """
    until = date.today()
    since = until - timedelta(days=days - 1)
    records = load_records(since, until)

    active_installs = set()
    for r in records:
        iid = r.get("install_id")
        if iid:
            active_installs.add(iid)

    return {
        "window_days": days,
        "since": since.isoformat(),
        "until": until.isoformat(),
        "weekly_active_count": len(active_installs),
        "total_flushes": len(records),
        "active_install_ids": sorted(active_installs),
    }


def summary_stats(days: int = 30) -> dict:
    """Full summary: active installs, learn/recall rates, version distribution."""
    until = date.today()
    since = until - timedelta(days=days - 1)
    records = load_records(since, until)

    per_install = defaultdict(lambda: {
        "learn_total": 0, "recall_total": 0, "session_total": 0,
        "flush_count": 0, "dates": set(), "versions": set(),
    })

    for r in records:
        iid = r.get("install_id", "unknown")
        per_install[iid]["learn_total"] += r.get("learn_count", 0)
        per_install[iid]["recall_total"] += r.get("recall_count", 0)
        per_install[iid]["session_total"] += r.get("session_count", 0)
        per_install[iid]["flush_count"] += 1
        per_install[iid]["dates"].add(r.get("date", ""))
        per_install[iid]["versions"].add(r.get("version", ""))

    active = len(per_install)
    total_learns = sum(v["learn_total"] for v in per_install.values())
    total_recalls = sum(v["recall_total"] for v in per_install.values())

    # H004 threshold check: >=5 learn AND >=10 recall per week
    strong_signal = sum(
        1 for v in per_install.values()
        if v["learn_total"] >= 5 and v["recall_total"] >= 10
    )
    any_activity = sum(
        1 for v in per_install.values()
        if v["learn_total"] > 0 or v["recall_total"] > 0
    )

    strong_pct = (strong_signal / active * 100) if active > 0 else 0
    any_pct = (any_activity / active * 100) if active > 0 else 0

    return {
        "window_days": days,
        "since": since.isoformat(),
        "until": until.isoformat(),
        "total_opted_in_installs": active,
        "total_flushes": len(records),
        "total_learns": total_learns,
        "total_recalls": total_recalls,
        "strong_signal_installs": strong_signal,
        "strong_signal_pct": round(strong_pct, 1),
        "any_activity_installs": any_activity,
        "any_activity_pct": round(any_pct, 1),
        "h004_threshold_strong": ">=30% strong signal → PASS" if strong_pct >= 30 else f"{strong_pct:.1f}% < 30% → NOT YET",
        "h004_threshold_mixed": ">=50% any activity → mixed signal" if any_pct >= 50 else f"{any_pct:.1f}% < 50%",
        "h004_threshold_invalidation": "<20% any activity → INVALIDATED" if any_pct < 20 and active >= 30 else "not invalidated",
        "sample_floor_met": active >= 30,
        "sample_floor_note": f"{active}/30 required installs — {'FLOOR MET' if active >= 30 else 'below floor, no threshold calls yet'}",
    }


def mau_stats() -> dict:
    """
    North-star metric: monthly_active_mcp_connections.
    Single pass over 30d of records; computes MAU/WAU/DAU from distinct install_ids.
    Output written to METRICS_DIR/YYYY-MM-DD.json when --write is used.
    """
    today = date.today()
    since_30d = today - timedelta(days=29)
    records = load_records(since_30d, today)

    since_7d = today - timedelta(days=6)
    since_1d = today

    ids_30d: set[str] = set()
    ids_7d: set[str] = set()
    ids_1d: set[str] = set()

    for r in records:
        iid = r.get("install_id")
        if not iid:
            continue
        try:
            record_date = date.fromisoformat(r.get("date", ""))
        except ValueError:
            continue
        ids_30d.add(iid)
        if record_date >= since_7d:
            ids_7d.add(iid)
        if record_date >= since_1d:
            ids_1d.add(iid)

    return {
        "date": today.isoformat(),
        "mau_30d": len(ids_30d),
        "wau_7d": len(ids_7d),
        "dau_1d": len(ids_1d),
        "total_flushes_30d": len(records),
    }


def main():
    parser = argparse.ArgumentParser(description="plur heartbeat query tool")
    parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default: 7)")
    parser.add_argument("--since", help="Start date YYYY-MM-DD (overrides --days)")
    parser.add_argument("--summary", action="store_true", help="Full summary with H004 threshold checks")
    parser.add_argument("--mau", action="store_true", help="North-star MAU/WAU/DAU metric")
    parser.add_argument("--write", action="store_true", help="With --mau: persist output to METRICS_DIR/YYYY-MM-DD.json")
    args = parser.parse_args()

    if args.mau:
        result = mau_stats()
        if args.write:
            METRICS_DIR.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(result, indent=2) + "\n"
            out_path = METRICS_DIR / f"{result['date']}.json"
            out_path.write_text(payload)
            (METRICS_DIR / "metrics-latest.json").write_text(payload)
        print(json.dumps(result, indent=2))
    elif args.summary:
        result = summary_stats(args.days)
        print(json.dumps(result, indent=2))
    else:
        days = args.days
        if args.since:
            since = date.fromisoformat(args.since)
            days = (date.today() - since).days + 1
        result = weekly_active_count(days)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
