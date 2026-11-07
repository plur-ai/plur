#!/usr/bin/env python3
"""CI hardening from the security audit 2026-11-06.

- windows-editors action: the latest channel (unpinned editor builds) never
  uses the shared pnpm cache that the pinned, release-gating runs restore.
- opencode-compat-monthly: the checkout does not persist the job token while
  @latest packages install and run.

Run: python3 scripts/test_ci_cache_isolation.py
"""
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def cache_value(expr: str, channel: str) -> str:
    """Evaluate the `cond && 'a' || 'b'` form GitHub uses ('' is falsy)."""
    m = re.fullmatch(r"\$\{\{\s*inputs\.channel\s*(==|!=)\s*'(\w+)'\s*&&\s*'(\w*)'\s*\|\|\s*'(\w*)'\s*\}\}", expr.strip())
    if not m:
        return expr  # a literal
    op, lit, a, b = m.groups()
    cond = (channel == lit) if op == '==' else (channel != lit)
    return (a if cond and a else b)


class WindowsEditorsCache(unittest.TestCase):
    def test_latest_channel_has_no_pnpm_cache(self) -> None:
        steps = yaml.safe_load((ROOT / '.github/actions/windows-editors/action.yml').read_text())['runs']['steps']
        node = [s for s in steps if str(s.get('uses', '')).startswith('actions/setup-node')]
        self.assertEqual(len(node), 1)
        expr = str(node[0]['with'].get('cache', ''))
        self.assertEqual(cache_value(expr, 'latest'), '')
        self.assertEqual(cache_value(expr, 'pinned'), 'pnpm')


class OpencodeCompatCheckout(unittest.TestCase):
    def test_checkout_does_not_persist_credentials(self) -> None:
        wf = yaml.safe_load((ROOT / '.github/workflows/opencode-compat-monthly.yml').read_text())
        checkouts = [s for job in wf['jobs'].values() for s in job.get('steps', [])
                     if str(s.get('uses', '')).startswith('actions/checkout')]
        self.assertTrue(checkouts)
        for s in checkouts:
            self.assertIs((s.get('with') or {}).get('persist-credentials'), False)



class CodexWslNodeDigest(unittest.TestCase):
    def test_node_tarball_checked_against_a_pinned_digest(self) -> None:
        text = (ROOT / ".github/workflows/codex-wsl.yml").read_text()
        self.assertNotIn("curl -fsSLO https://nodejs.org/dist/v24.13.0/SHASUMS256.txt", text)
        self.assertRegex(text, r"echo '[0-9a-f]{64}  node-v[0-9.]+-linux-x64\.tar\.xz' \| sha256sum -c -")


if __name__ == '__main__':
    unittest.main()
