"""formal_check.py without the Lean toolchain (#1241).

Run: python3 -m unittest spec/formal/test_formal_check.py
"""
import contextlib
import io
import unittest
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import formal_check  # noqa: E402


class NoLake(unittest.TestCase):
    def run_check(self, *argv):
        out = io.StringIO()
        with mock.patch.object(formal_check, "have_lake", return_value=False), \
             mock.patch.object(formal_check, "lake", return_value="/nonexistent/lake"), \
             contextlib.redirect_stdout(out):
            code = formal_check.main(list(argv))
        return code, out.getvalue()

    def test_no_build_without_lake_skips_the_lean_checks_and_runs_the_rest(self):
        code, out = self.run_check("--no-build")
        self.assertEqual(code, 0, out)
        self.assertIn("skip axioms", out)
        self.assertIn("gaps", out)
        self.assertIn("drift", out)

    def test_build_without_lake_is_skipped_not_a_traceback(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("skip build", out)


if __name__ == "__main__":
    unittest.main()
