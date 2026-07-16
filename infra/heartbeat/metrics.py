#!/usr/bin/env python3
"""
metrics.py — daily aggregation of plur heartbeat data.

Reads:  HEARTBEAT_DATA_DIR/YYYY-MM-DD.jsonl  (one file per day)
Writes: HEARTBEAT_DATA_DIR/metrics-YYYY-MM-DD.json  (dated snapshot)
        HEARTBEAT_DATA_DIR/metrics-latest.json       (always current)

Output fields:
  date          YYYY-MM-DD (UTC today)
  mau_30d       distinct install_ids with ≥1 heartbeat ping in last 30 days
  mau_14d       distinct install_ids with ≥1 heartbeat ping in last 14 days
  wau_7d        distinct install_ids with ≥1 heartbeat ping in last 7 days
  dau_1d        distinct install_ids with ≥1 heartbeat ping yesterday
  sessions_30d  sum of session_count over last 30 days
  learns_30d    sum of learn_count over last 30 days
  recalls_30d   sum of recall_count over last 30 days

Usage:
  python3 /opt/plur-heartbeat/metrics.py

Cron (installed by deploy.sh — runs at 01:00 UTC daily):
  0 1 * * * /usr/bin/python3 /opt/plur-heartbeat/metrics.py
"""
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

DATA_DIR = Path(os.environ.get("HEARTBEAT_DATA_DIR", "/var/lib/plur-heartbeat"))


def compute_metrics(today: date) -> dict:
    cutoffs = {
        "30d": today - timedelta(days=30),
        "14d": today - timedelta(days=14),
        "7d":  today - timedelta(days=7),
        "1d":  today - timedelta(days=1),
    }

    ids: dict[str, set] = {k: set() for k in cutoffs}
    sessions_30d = 0
    learns_30d   = 0
    recalls_30d  = 0

    for path in sorted(DATA_DIR.glob("????-??-??.jsonl")):
        try:
            file_date = date.fromisoformat(path.stem)
        except ValueError:
            continue

        if file_date < cutoffs["30d"]:
            continue

        with open(path) as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                install_id = rec.get("install_id")
                if not isinstance(install_id, str) or not install_id:
                    continue

                for window, cutoff in cutoffs.items():
                    if file_date >= cutoff:
                        ids[window].add(install_id)

                if file_date >= cutoffs["30d"]:
                    sessions_30d += int(rec.get("session_count", 0) or 0)
                    learns_30d   += int(rec.get("learn_count",   0) or 0)
                    recalls_30d  += int(rec.get("recall_count",  0) or 0)

    return {
        "date":         today.isoformat(),
        "mau_30d":      len(ids["30d"]),
        "mau_14d":      len(ids["14d"]),
        "wau_7d":       len(ids["7d"]),
        "dau_1d":       len(ids["1d"]),
        "sessions_30d": sessions_30d,
        "learns_30d":   learns_30d,
        "recalls_30d":  recalls_30d,
    }


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today()
    metrics = compute_metrics(today)

    dated_path  = DATA_DIR / f"metrics-{metrics['date']}.json"
    latest_path = DATA_DIR / "metrics-latest.json"

    payload = json.dumps(metrics, indent=2) + "\n"
    dated_path.write_text(payload)
    latest_path.write_text(payload)

    print(payload, end="")


if __name__ == "__main__":
    main()
