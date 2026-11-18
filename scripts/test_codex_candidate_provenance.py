#!/usr/bin/env python3
"""Security audit 2026-11-06: the desktop runbook checks the producing run before any install."""
from pathlib import Path

RUNBOOK = Path(__file__).resolve().parent.parent / 'docs/runbooks/codex-desktop-acceptance.txt'


def test_run_is_checked_before_install():
    text = RUNBOOK.read_text()
    check = text.find('gh run view <run-id> --repo plur-ai/plur --json workflowName,event,headBranch,headSha,conclusion')
    assert 0 <= check < text.index('npm install -g')
