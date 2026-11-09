#!/usr/bin/env python3
"""Does the PLUR directory plugin help a Claude Code user, compared with what they already have?

A convention is stated in one session. A later, separate session gets a task whose
right answer depends on it, in an empty folder, so memory is the only possible source.

Conditions:
  none          no plugin, Claude's built-in memory off (floor)
  builtin       no plugin, built-in memory on (what users already have)
  plugin_named  plugin + built-in memory, the user says "save to PLUR"
  plugin_plain  plugin + built-in memory, the user just states the convention

Leak check: after plugin_named, the same task runs in a different project that shares
the store. A convention of one project showing up there is harm, not benefit.

Uses a throwaway store per trial, and --strict-mcp-config so no other MCP server
(the owner's real memory, connectors) can be reached.

Usage: directory_plugin_benefit_eval.py <plur-worktree> <work-dir> [--reps N] [--jobs N] [--model M]
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCENARIOS = [
    ("bun", "For this project we use Bun, never npm or yarn.",
     "Give the shell command to add lodash to this project. Reply with only the command.",
     r"^\W*bun\s+(add|install|i)\b"),
    ("api_key", "In this project, API error responses always use the key `problem`, never `error` or `message`.",
     "Write a one-line JSON example of this project's API error response for a missing user. Reply with only the JSON.",
     r'"problem"\s*:'),
    ("logger", "In this project, the Python logger is always named `audit_log`.",
     "Write one line of Python that logs 'started' at info level using this project's logger. Reply with only the code.",
     r"audit_log"),
    ("branch", "In this project, git branch names always start with `gs/`.",
     "Suggest a git branch name for a fix to the login page. Reply with only the name.",
     r"^\W*gs/"),
    ("deploy", "This project only deploys on Tuesdays.",
     "Which weekday does this project deploy on? Reply with one word, or 'unknown' if you do not know.",
     r"tuesday"),
]

# A preference that should follow the person into every project. Same shape, opposite
# expectation: here appearing in the other project is the benefit, not a leak.
PERSONAL = [
    ("commit_tag", "Across all my projects, my commit messages always end with the tag [gs].",
     "Write a one-line commit message for fixing a typo in the README. Reply with only the message.",
     r"\[gs\]"),
    ("test_dir", "Across all my projects, I name the test folder `checks`, never `tests`.",
     "What should I name the folder that holds the tests? Reply with one word.",
     r"\bchecks\b"),
    ("reports", "Across all my projects, I call my status reports the Daily Ledger.",
     "What do I call my status reports? Reply with the name, or 'unknown' if you do not know.",
     r"ledger"),
]

CONDITIONS = ["none", "builtin", "plugin_named", "plugin_plain"]
KEEP = " Please keep that in mind for future sessions."
FOLDER_SCOPE = False


def claude(prompt, cwd, env, plugin, model):
    # --strict-mcp-config also drops a plugin's own server, so the plugin's server
    # is passed explicitly: same command and env, and nothing else is reachable.
    servers = {}
    if plugin:
        declared = json.loads((plugin / ".mcp.json").read_text())["mcpServers"]["plur"]
        servers["plur"] = {**declared, "env": {**declared["env"], "PLUR_PATH": env["PLUR_PATH"], "PLUR_MODEL_DOWNLOAD": "off"}}
    cmd = ["claude", "-p", prompt, "--model", model, "--setting-sources", "project",
           "--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": servers})]
    if plugin:
        cmd += ["--plugin-dir", str(plugin), "--allowedTools", "mcp__plur__*"]
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=240)
        return (r.stdout or "").strip()
    except subprocess.TimeoutExpired:
        return "__TIMEOUT__"


def prepare_plugin(worktree: Path, work: Path) -> Path:
    """The real plugin folder, with the server and hooks pointed at the local build."""
    plugin = work / "plugin"
    if plugin.exists():
        shutil.rmtree(plugin)
    shutil.copytree(worktree / "plugins" / "plur", plugin)
    mcp = plugin / ".mcp.json"
    data = json.loads(mcp.read_text())
    server = data["mcpServers"]["plur"]
    server["command"] = "node"
    server["args"] = [str(worktree / "packages/mcp/dist/index.js")]
    mcp.write_text(json.dumps(data))
    hook = plugin / "scripts" / "run-hook.sh"
    hook.write_text(f'#!/bin/sh\nexport PLUR_FOLDER_SCOPE=project\nexec node "{worktree}/packages/cli/dist/index.js" "$@"\n')
    hook.chmod(0o755)
    return plugin


def turn_folders_on(store, folders, scoped=False):
    """Seed the throwaway store as if the user had answered yes. `plur folders set`
    refuses without a nonce when not in a terminal, which is right for real users;
    the answer flow itself is covered by a separate end-to-end run."""
    body = "".join(f'  - path: "{f}"\n    plur: on\n' + (f"    scope: project:{f.name}\n" if scoped else "") for f in folders)
    (store / "folders.yaml").write_text(f"version: 1\nfolders:\n{body}")


def trial(args):
    cond, (name, fact, task, pattern), rep, worktree, work, plugin, model, git = args
    # Opaque path: a folder named after the scenario hands the model the answer.
    root = work / "trials" / hashlib.sha256(f"{cond}{name}{rep}".encode()).hexdigest()[:10]
    if root.exists():
        shutil.rmtree(root)
    project, other, store = root / "project", root / "other", root / "store"
    for d in (project, other, store):
        d.mkdir(parents=True)
    env = {**os.environ, "PLUR_PATH": str(store), "PLUR_MODEL_DOWNLOAD": "off"}
    if cond == "none":
        env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    use = plugin if cond.startswith("plugin") else None
    if git:
        for folder, origin in ((project, "alpha-app"), (other, "beta-site")):
            subprocess.run(["git", "init", "-q"], cwd=folder, check=True)
            subprocess.run(["git", "remote", "add", "origin", f"https://github.com/example-org/{origin}.git"], cwd=folder, check=True)
    if use:
        turn_folders_on(store, [project, other], scoped=FOLDER_SCOPE)
    say = f"Save to PLUR: {fact}" if cond == "plugin_named" else fact + KEEP
    first = claude(say, project, env, use, model)
    second = claude(task, project, env, use, model)
    result = {"cond": cond, "scenario": name, "rep": rep, "answer": second[:300], "first": first[:200],
              "pass": bool(re.search(pattern, second, re.I | re.M))}
    engrams = store / "engrams.yaml"
    result["in_plur"] = engrams.exists() and "statement" in engrams.read_text()
    elsewhere = claude(task, other, env, use, model)
    result["other_answer"] = elsewhere[:300]
    result["other_hit"] = bool(re.search(pattern, elsewhere, re.I | re.M))
    result["scope"] = sorted(set(re.findall(r"^\s*scope:\s*(\S+)", engrams.read_text(), re.M))) if engrams.exists() else []
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("worktree", type=Path)
    ap.add_argument("work", type=Path)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--jobs", type=int, default=5)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--git", action="store_true", help="make each folder a git repo with its own origin")
    ap.add_argument("--only", default="", help="comma-separated conditions")
    ap.add_argument("--scenarios", default="", help="comma-separated scenario names")
    ap.add_argument("--folder-scope", action="store_true", help="each folder's memory entry carries its own project scope")
    a = ap.parse_args()
    global FOLDER_SCOPE
    FOLDER_SCOPE = a.folder_scope
    a.work.mkdir(parents=True, exist_ok=True)
    plugin = prepare_plugin(a.worktree, a.work)
    conds = a.only.split(",") if a.only else CONDITIONS
    scens = [s for s in SCENARIOS + PERSONAL if not a.scenarios or s[0] in a.scenarios.split(",")]
    jobs = [(c, s, r, a.worktree, a.work, plugin, a.model, a.git) for c in conds for s in scens for r in range(a.reps)]
    with ThreadPoolExecutor(a.jobs) as pool:
        results = list(pool.map(trial, jobs))
    (a.work / "results.json").write_text(json.dumps(results, indent=1))
    personal = {p[0] for p in PERSONAL}
    for c in conds:
        rs = [r for r in results if r["cond"] == c]
        proj = [r for r in rs if r["scenario"] not in personal]
        pers = [r for r in rs if r["scenario"] in personal]
        print(f"{c:13} same_project_pass {sum(r['pass'] for r in rs):3}/{len(rs)}"
              f"  project_fact_leaked {sum(r['other_hit'] for r in proj):3}/{len(proj)}"
              f"  personal_followed {sum(r['other_hit'] for r in pers):3}/{len(pers)}"
              f"  saved_in_plur {sum(r['in_plur'] for r in rs):3}")
    print("scopes", sorted({x for r in results for x in r["scope"]}))


if __name__ == "__main__":
    main()
