#!/usr/bin/env python3
"""PreToolUse hook: ask the owner before an existing promise eval is changed.

The builder never edits its own judge. Writing a NEW eval stays open (that is
how evals get written); editing, overwriting, moving or deleting an existing
`test_promise_*.py` or `test_promise_*.test.ts` asks first -- and so does any
existing file under an `evals/mutants/` (the planted bugs) or `evals/gold/`
(labelled answers) folder: they are part of the judge. Wire it in the repo's .claude/settings.json:

    {"hooks": {"PreToolUse": [{"matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
      "hooks": [{"type": "command", "command": "python3 .evals/guard.py"}]}]}}

A Datacore install already has this guard for its own evals; use this one in
other repos. Unattended agents are told the rule, and their commits are checked
afterwards: `git diff --name-only <range> | grep test_promise_` must be empty.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EVAL = re.compile(r"test_promise_[\w.-]*\.(?:py|ts|mts|js|mjs)")
JUDGE_DIRS = re.compile(r"(?:^|[/\s'\"])evals/(?:mutants|gold)/[^\s'\"]+")
FILE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
MUTATING = re.compile(r"(^|[\s;&|(])(rm|mv|cp|git\s+rm|git\s+mv|git\s+checkout|sed\s+-i|perl\s+-[a-z]*i|truncate|tee"
                      r"|chmod|ln)\b|>{1,2}\s*\S*(?:test_promise_|evals/mutants/|evals/gold/)")
REASON = ("Eval guard: this changes an existing promise eval. The builder never edits its own judge -- "
          "if the eval looks wrong, report it; change it only with the owner's yes.")


def decision(tool: str, inp: dict) -> str | None:
    if tool in FILE_TOOLS:
        path = str(inp.get("file_path") or inp.get("notebook_path") or inp.get("path") or "")
        if not (EVAL.fullmatch(Path(path).name) or JUDGE_DIRS.search(path)):
            return None
        return "ask" if tool != "Write" or Path(path).expanduser().exists() else None
    if tool == "Bash":
        cmd = str(inp.get("command") or "")
        return "ask" if (EVAL.search(cmd) or JUDGE_DIRS.search(cmd)) and MUTATING.search(cmd) else None
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    inp = payload.get("tool_input") or {}
    if isinstance(inp, dict) and decision(str(payload.get("tool_name") or ""), inp) == "ask":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "permissionDecision": "ask",
                                                 "permissionDecisionReason": REASON}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - a broken guard must not block tool use
        sys.exit(0)
