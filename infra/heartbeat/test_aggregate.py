"""Unit tests for H005 E1 cohort aggregation script.

Covers: empty corpus, single install, mixed retention, cohort boundary,
week boundary math, week-4 engagement vs. presence distinction.
"""

import json
import pathlib
import tempfile
import unittest
from datetime import date

from aggregate import (
    COHORT_END,
    COHORT_START,
    compute_cohort_metrics,
    compute_install_metrics,
    derive_cohort,
    load_corpus,
    main,
)


def _rec(install_id, d, learn=0, recall=0, session=0, version="0.9.4", platform="linux"):
    return {
        "install_id":    install_id,
        "version":       version,
        "platform":      platform,
        "date":          date.fromisoformat(d) if isinstance(d, str) else d,
        "learn_count":   learn,
        "recall_count":  recall,
        "session_count": session,
    }


def _write_jsonl(tmp: pathlib.Path, records: list) -> None:
    """Write records to per-date .jsonl files."""
    by_date: dict = {}
    for r in records:
        d = r["date"] if isinstance(r["date"], str) else r["date"].isoformat()
        by_date.setdefault(d, []).append({**r, "date": d})
    for d, recs in by_date.items():
        path = tmp / f"{d}.jsonl"
        with path.open("a") as fh:
            for rec in recs:
                fh.write(json.dumps(rec) + "\n")


class TestLoadCorpus(unittest.TestCase):
    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as d:
            result = load_corpus(pathlib.Path(d))
        self.assertEqual(result, {})

    def test_skips_malformed_lines(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "2026-05-14.jsonl"
            p.write_text('{"bad": true}\nnot-json\n')
            result = load_corpus(pathlib.Path(d))
        self.assertEqual(result, {})

    def test_parses_valid_records(self):
        with tempfile.TemporaryDirectory() as d:
            td = pathlib.Path(d)
            _write_jsonl(td, [_rec("aaa", "2026-05-20", learn=1)])
            result = load_corpus(td)
        self.assertIn("aaa", result)
        self.assertEqual(len(result["aaa"]), 1)
        self.assertEqual(result["aaa"][0]["learn_count"], 1)


class TestDeriveCohort(unittest.TestCase):
    def _make(self, iid, dates):
        return {iid: [_rec(iid, d) for d in dates]}

    def test_inside_window(self):
        by_install = self._make("x", ["2026-05-14"])
        cohort = derive_cohort(by_install)
        self.assertIn("x", cohort)

    def test_before_window(self):
        by_install = self._make("x", ["2026-05-13"])
        cohort = derive_cohort(by_install)
        self.assertNotIn("x", cohort)

    def test_on_end_boundary_excluded(self):
        by_install = self._make("x", ["2026-06-13"])
        cohort = derive_cohort(by_install)
        self.assertNotIn("x", cohort)

    def test_install_date_is_earliest(self):
        by_install = self._make("x", ["2026-05-20", "2026-05-15", "2026-05-18"])
        cohort = derive_cohort(by_install)
        self.assertEqual(cohort["x"]["install_date"], date(2026, 5, 15))

    def test_install_before_window_but_activity_inside(self):
        # install_date derived from corpus — if first seen heartbeat is before
        # the cohort window, this install is excluded even if it also has
        # heartbeats inside the window.
        by_install = {"x": [_rec("x", "2026-05-13"), _rec("x", "2026-05-20")]}
        cohort = derive_cohort(by_install)
        self.assertNotIn("x", cohort)


class TestComputeInstallMetrics(unittest.TestCase):
    def _cohort(self, iid, records):
        install_date = min(r["date"] if isinstance(r["date"], date)
                          else date.fromisoformat(r["date"]) for r in records)
        parsed = []
        for r in records:
            rc = dict(r)
            if isinstance(rc["date"], str):
                rc["date"] = date.fromisoformat(rc["date"])
            parsed.append(rc)
        return {iid: {"install_date": install_date, "records": parsed}}

    def test_zero_activity(self):
        cohort = self._cohort("a", [_rec("a", "2026-05-14", session=0)])
        rows = compute_install_metrics(cohort)
        self.assertEqual(rows[0]["active_days_w1"], 0)
        self.assertEqual(rows[0]["week4_active"], False)

    def test_active_day_counting(self):
        # One active day each in W1, W2, W3, W4
        cohort = self._cohort("a", [
            _rec("a", "2026-05-14", session=1),           # W1 day 0
            _rec("a", "2026-05-21", session=1),           # W2 day 7
            _rec("a", "2026-05-28", session=1),           # W3 day 14
            _rec("a", "2026-06-04", learn=1),             # W4 day 21
        ])
        rows = compute_install_metrics(cohort)
        r = rows[0]
        self.assertEqual(r["active_days_w1"], 1)
        self.assertEqual(r["active_days_w2"], 1)
        self.assertEqual(r["active_days_w3"], 1)
        self.assertEqual(r["active_days_w4"], 1)

    def test_week4_active_requires_learn_or_recall_not_session_only(self):
        install_date = "2026-05-14"
        cohort = self._cohort("a", [
            _rec("a", "2026-06-04", session=1, learn=0, recall=0),  # W4 but session-only
        ])
        rows = compute_install_metrics(cohort)
        self.assertFalse(rows[0]["week4_active"])

    def test_week4_active_true_with_recall(self):
        # install_date = 2026-05-14; W4 = [+21d, +28d) = [2026-06-04, 2026-06-11)
        cohort = self._cohort("a", [
            _rec("a", "2026-05-14", session=1),  # install anchor
            _rec("a", "2026-06-04", recall=1),   # W4 day, recall event
        ])
        rows = compute_install_metrics(cohort)
        self.assertTrue(rows[0]["week4_active"])

    def test_week_boundary_math(self):
        # install_date = 2026-05-14 (day 0); day 6 = W1 last; day 7 = W2 first
        cohort = self._cohort("a", [
            _rec("a", "2026-05-14", session=1),  # install anchor (W1 day 0)
            _rec("a", "2026-05-20", session=1),  # install_date + 6 → W1
            _rec("a", "2026-05-21", session=1),  # install_date + 7 → W2
        ])
        rows = compute_install_metrics(cohort)
        r = rows[0]
        self.assertEqual(r["active_days_w1"], 2)   # day 0 + day 6
        self.assertEqual(r["active_days_w2"], 1)   # day 7 only

    def test_totals_accumulated(self):
        cohort = self._cohort("a", [
            _rec("a", "2026-05-14", learn=3, recall=2),
            _rec("a", "2026-05-15", learn=1, recall=0),
        ])
        rows = compute_install_metrics(cohort)
        self.assertEqual(rows[0]["learn_total"], 4)
        self.assertEqual(rows[0]["recall_total"], 2)


class TestComputeCohortMetrics(unittest.TestCase):
    def _row(self, w1=0, w2=0, w3=0, w4=0, w4_active=False):
        return {
            "install_id": "x", "install_date": "2026-05-14",
            "platform": "linux", "version_at_install": "0.9.4",
            "active_days_w1": w1, "active_days_w2": w2,
            "active_days_w3": w3, "active_days_w4": w4,
            "learn_total": 0, "recall_total": 0,
            "week4_active": w4_active,
        }

    def test_empty_cohort(self):
        m = compute_cohort_metrics([])
        self.assertEqual(m["cohort_size"], 0)
        self.assertEqual(m["verdict"], "invalidate")
        self.assertTrue(m["invalidates_h005"])

    def test_validates(self):
        # 3 active days/week median, >30% W4 retention
        rows = [
            self._row(w1=7, w2=7, w3=7, w4=7, w4_active=True),   # 7 each week
            self._row(w1=7, w2=7, w3=7, w4=7, w4_active=True),
            self._row(w1=0, w2=0, w3=0, w4=0, w4_active=False),   # ghost
        ]
        m = compute_cohort_metrics(rows)
        self.assertEqual(m["verdict"], "validate")
        self.assertTrue(m["validates_h005"])
        self.assertFalse(m["invalidates_h005"])

    def test_invalidates_low_w4_retention(self):
        # 0% W4 retention → invalidate regardless of median
        rows = [
            self._row(w1=7, w2=7, w3=7, w4=0, w4_active=False),
            self._row(w1=7, w2=7, w3=7, w4=0, w4_active=False),
        ]
        m = compute_cohort_metrics(rows)
        self.assertEqual(m["verdict"], "invalidate")
        self.assertTrue(m["invalidates_h005"])

    def test_invalidates_low_median(self):
        rows = [
            self._row(w1=0, w2=0, w3=0, w4=1, w4_active=True),  # median apw = 0.25
        ]
        m = compute_cohort_metrics(rows)
        self.assertEqual(m["verdict"], "invalidate")

    def test_inconclusive(self):
        # median = 1.0 (above 0.5, below 1.5), w4_pct = 50% (above 10%, below 30%)
        # 50% meets stretch but not validate threshold... let me recalculate:
        # validate needs median>=1.5 AND w4_pct>=30%
        # one row: w1=4,w2=4,w3=0,w4=0 → apw = (4+4+0+0)/4 = 2.0, w4_pct=0% → invalidate
        # need: above anti-metric floor but below validate threshold
        # w4_pct >=10%, <30%; median >= 0.5, < 1.5
        rows = [
            self._row(w1=1, w2=1, w3=1, w4=1, w4_active=True),   # apw=1.0, w4_active
            self._row(w1=1, w2=1, w3=1, w4=1, w4_active=False),  # apw=1.0
            self._row(w1=1, w2=1, w3=1, w4=1, w4_active=False),  # apw=1.0
            self._row(w1=1, w2=1, w3=1, w4=1, w4_active=False),  # apw=1.0
            self._row(w1=1, w2=1, w3=1, w4=1, w4_active=False),  # apw=1.0
        ]
        # median apw = 1.0 (< 1.5), w4_pct = 20% (>= 10%, < 30%) → inconclusive
        m = compute_cohort_metrics(rows)
        self.assertEqual(m["verdict"], "inconclusive")
        self.assertFalse(m["validates_h005"])
        self.assertFalse(m["invalidates_h005"])

    def test_platform_breakdown(self):
        rows = [
            {**self._row(), "platform": "darwin"},
            {**self._row(), "platform": "linux"},
            {**self._row(), "platform": "linux"},
        ]
        m = compute_cohort_metrics(rows)
        self.assertEqual(m["platform_breakdown"]["linux"], 2)
        self.assertEqual(m["platform_breakdown"]["darwin"], 1)


class TestEndToEnd(unittest.TestCase):
    def _make_jsonl(self, tmp, records):
        _write_jsonl(tmp, records)

    def test_single_install_full_engagement(self):
        with tempfile.TemporaryDirectory() as data_d, \
             tempfile.TemporaryDirectory() as out_d:
            data_dir = pathlib.Path(data_d)
            out_dir  = pathlib.Path(out_d)
            # Install on 2026-05-14, active every day for 4 weeks, W4 has learn event
            for offset in range(28):
                d = date(2026, 5, 14) + __import__("datetime").timedelta(days=offset)
                ds = d.isoformat()
                learn = 1 if offset >= 21 else 0
                _write_jsonl(data_dir, [_rec("install-1", ds, session=1, learn=learn)])

            main(["--data-dir", str(data_dir), "--out-dir", str(out_d)])

            metrics = json.loads((out_dir / "metrics.json").read_text())
            self.assertEqual(metrics["cohort_size"], 1)
            self.assertEqual(metrics["verdict"], "validate")
            self.assertGreaterEqual(metrics["median_active_days_per_week"], 1.5)
            self.assertGreater(metrics["week4_retention_pct"], 0.0)

            cohort_csv = (out_dir / "cohort.csv").read_text()
            self.assertIn("install-1", cohort_csv)

            summary = (out_dir / "summary.md").read_text()
            self.assertIn("VALIDATE", summary)

    def test_install_and_forget(self):
        with tempfile.TemporaryDirectory() as data_d, \
             tempfile.TemporaryDirectory() as out_d:
            data_dir = pathlib.Path(data_d)
            # One install, only W1 activity, nothing after
            _write_jsonl(data_dir, [_rec("ghost", "2026-05-14", session=1)])

            main(["--data-dir", str(data_dir), "--out-dir", str(out_d)])

            metrics = json.loads((pathlib.Path(out_d) / "metrics.json").read_text())
            self.assertEqual(metrics["verdict"], "invalidate")
            self.assertTrue(metrics["invalidates_h005"])

    def test_idempotent(self):
        with tempfile.TemporaryDirectory() as data_d, \
             tempfile.TemporaryDirectory() as out_d:
            data_dir = pathlib.Path(data_d)
            _write_jsonl(data_dir, [_rec("a", "2026-05-20", learn=1)])

            main(["--data-dir", str(data_dir), "--out-dir", str(out_d)])
            first  = json.loads((pathlib.Path(out_d) / "metrics.json").read_text())
            main(["--data-dir", str(data_dir), "--out-dir", str(out_d)])
            second = json.loads((pathlib.Path(out_d) / "metrics.json").read_text())
            self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
