#!/usr/bin/env python3
"""The Codex desktop candidate is installed only from a main-branch run.

Security audit 2026-11-06: the desktop-acceptance runbook picked the
plur-codex-candidate artifact by name and green status, which pull request runs
also produce. The runbook must bind the producer (run event, branch, head SHA)
before any install; the upload step skips pull request runs as defence in depth.

Run: python3 scripts/test_codex_candidate_provenance.py
"""
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
RUNBOOK = ROOT / 'docs/runbooks/codex-desktop-acceptance.txt'
ACTION = ROOT / '.github/actions/windows-editors/action.yml'


class RunbookBindsTheProducer(unittest.TestCase):
    def setUp(self) -> None:
        self.text = RUNBOOK.read_text()
        self.install = self.text.index('npm install -g')

    def before_install(self, needle: str) -> bool:
        at = self.text.find(needle)
        return 0 <= at < self.install

    def test_run_is_checked_before_install(self) -> None:
        self.assertTrue(self.before_install(
            'gh run view <run-id> --repo plur-ai/plur --json workflowName,event,headBranch,headSha,conclusion'))

    def test_each_condition_is_required(self) -> None:
        head = self.text[:self.install]
        self.assertRegex(head, r'workflowName is "Windows real editors"')
        self.assertRegex(head, r'event is push or workflow_dispatch')
        self.assertRegex(head, r'headBranch is main')
        self.assertRegex(head, r'conclusion is success')
        self.assertRegex(head, r'headSha is')

    def test_download_is_by_run_id_and_head_sha(self) -> None:
        self.assertTrue(self.before_install('gh run download <run-id> --repo plur-ai/plur -n plur-codex-candidate-<headSha>'))

    def test_no_selection_by_name_alone(self) -> None:
        self.assertNotRegex(self.text, re.compile(r'download the plur-codex-candidate artifact from the passing', re.I))


class UploadSkipsPullRequests(unittest.TestCase):
    def test_upload_condition_excludes_pull_request(self) -> None:
        steps = yaml.safe_load(ACTION.read_text())['runs']['steps']
        upload = [s for s in steps if str(s.get('uses', '')).startswith('actions/upload-artifact')
                  and 'plur-codex-candidate' in str(s.get('with', {}).get('name', ''))]
        self.assertEqual(len(upload), 1)
        cond = upload[0].get('if', '')
        self.assertIn("github.event_name != 'pull_request'", cond)
        self.assertIn("github.event_name != 'pull_request_target'", cond)


if __name__ == '__main__':
    unittest.main()
