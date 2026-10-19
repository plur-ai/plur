#!/usr/bin/env python3
"""Triage: every red promise, rerun alone, read from its CURRENT failure, in exactly one bucket.

The bucket decides who acts:

    code-bug          fixable now; the eval is already red
    job-did-not-run   a scheduled job did not do its work -- look at its last run
    external-release  waits on another repo's release or pull request
    owner             money, accounts, permissions, merges: the owner decides or acts
    time              needs real nights or a date; say the earliest green date
    no-eval           no eval yet: one is drafted red and approved by the owner
    eval-problem      the eval itself looks wrong: stop and report, never edit it

A red that passes when rerun alone is `load-flaky`: reported, not acted on.

Classification is rule-based on the failure text. An eval may name its bucket
with `[triage:<bucket>]` in its failure message; `triage.overrides.yaml`
(`ID: {bucket: owner, note: ...}`) wins over both.

Usage:
    triage.py --config evals.yaml [--from board.json] [--out red-promises-DATE.md] [--json]
Exit 0 when resting: every red is classified and none is agent-actionable.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import importlib.util
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path


def _sibling(name: str):
    key = f"evals_{name}"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
        sys.modules[key] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[key])
    return sys.modules[key]


run = _sibling("run")

#: bucket -> page heading, in page order
BUCKETS = {
    "code-bug": "Code bugs — fixable without the owner",
    "job-did-not-run": "Jobs that did not do their work — look at the job's last run",
    "external-release": "Waiting on an external release",
    "owner": "Owner decision or action",
    "time": "Waiting on time",
    "no-eval": "No eval yet",
    "eval-problem": "Eval problem — reported, not edited",
}
AGENT_ACTIONABLE = {"code-bug", "job-did-not-run"}

#: (bucket, pattern) tried in order on the failure text; the first match wins
RULES = [
    ("eval-problem", r"ImportError while importing test module|SyntaxError|fixture '[^']*' not found"
                     r"|collection failure|errors? during collection"),
    ("time", r"earliest green|window is not full|not due until|needs? real nights|wait(ing)? until"),
    ("external-release", r"upstream|external release|waiting on .{0,40}release|pull request|\bPR #\d+"),
    ("owner", r"\bowner\b|needs a decision"),
    ("job-did-not-run", r"could not tell|last ran|did not run|never ran|no run\b|processed 0|stale"),
]


def classify(text: str, status: str) -> str:
    m = re.search(r"\[triage:([a-z-]+)\]", text or "")
    if m and m.group(1) in BUCKETS:
        return m.group(1)
    if status == "no-eval":
        return "no-eval"
    for bucket, pat in RULES:
        if re.search(pat, text or "", re.I):
            return bucket
    return "code-bug"


def load_overrides(path: Path | None) -> dict[str, dict]:
    if not path or not Path(path).exists():
        return {}
    import yaml
    doc = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    return {run.norm(k): (v or {}) for k, v in doc.items()}


def bucket_for(nid: str, text: str, status: str, overrides: dict) -> tuple[str, str]:
    o = overrides.get(run.norm(nid))
    if o and o.get("bucket") in BUCKETS:
        return o["bucket"], str(o.get("note") or "")
    return classify(text, status), str((o or {}).get("note") or "")


@dataclass
class Row:
    pid: str
    text: str
    bucket: str
    seen: str
    note: str
    files: list[str]


@dataclass
class Result:
    rows: list[Row]
    counts: dict = field(default_factory=dict)


def triage(cfg, board, score=None, overrides=None) -> Result:
    """Rerun each red alone; keep its current failure; bucket it."""
    score = score or run.score
    overrides = load_overrides(cfg.overrides) if overrides is None else overrides
    rows: list[Row] = []
    for pid, st in board.status.items():
        if st == "green":
            continue
        files = list(board.files.get(pid, []))
        if st == "no-eval":
            b, note = bucket_for(pid, "", st, overrides)
            rows.append(Row(pid, board.text[pid], b, "no eval file", note, files))
            continue
        alone = score(cfg, only={run.norm(pid)})
        if alone.status.get(pid) == "green":
            rows.append(Row(pid, board.text[pid], "load-flaky",
                            "red on the full run, green when rerun alone. First failure: "
                            + (board.details.get(pid) or "")[:400], "", files))
            continue
        seen = alone.details.get(pid) or board.details.get(pid) or ""
        b, note = bucket_for(pid, seen, "red", overrides)
        rows.append(Row(pid, board.text[pid], b, seen, note, files))
    counts: dict[str, int] = {}
    for r in rows:
        counts[r.bucket] = counts.get(r.bucket, 0) + 1
    return Result(rows, counts)


def resting(result: Result) -> bool:
    """Every red is classified, owned, and not agent-actionable: a goal loop may stop."""
    return not any(r.bucket in AGENT_ACTIONABLE for r in result.rows)


def write_page(result: Result, path: Path, date: str | None = None) -> Path:
    date = date or _dt.date.today().isoformat()
    red = sum(1 for r in result.rows if r.bucket != "no-eval")
    none = sum(1 for r in result.rows if r.bucket == "no-eval")
    out = [f"# The promises that are not green — {date} ({red + none}: {red} red, {none} without an eval)", "",
           "Each red was rerun alone and classified from its current failure text, not from memory.", ""]
    n = 0
    for bucket, heading in list(BUCKETS.items()) + [("load-flaky", "Load-flaky — passed when rerun alone")]:
        rows = [r for r in result.rows if r.bucket == bucket]
        if not rows:
            continue
        out += [f"## {heading}", ""]
        if bucket == "load-flaky":
            out += ["Red on the full run, green alone: not acted on. Watch whether it recurs.", ""]
        for r in rows:
            n += 1
            out.append(f"### {n}. {r.text} ({r.pid})")
            seen = " ".join(r.seen.split())
            out.append(f"- **Seen:** {seen[:700]}" if seen else "- **Seen:** (no failure text)")
            if r.note:
                out.append(f"- **Note:** {r.note}")
            if r.files:
                out.append("- **Eval:** " + ", ".join(f"`{Path(f.split(':', 1)[-1]).name}`" for f in r.files))
            out.append("")
    out.append(f"Resting (no red an agent can act on): {'yes' if resting(result) else 'no'}")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="evals.yaml")
    ap.add_argument("--root", default=None)
    ap.add_argument("--from", dest="source", default=None, help="a saved `run.py --json` board, instead of a run")
    ap.add_argument("--out", default=None)
    ap.add_argument("--agents", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    cfg = _sibling("config").load(args.config, root=args.root)
    if args.source:
        doc = json.loads(Path(args.source).read_text())
        texts = run.promises(cfg)
        board = run.Board(status=doc["promises"], text={p: texts.get(p, "") for p in doc["promises"]},
                          details=doc.get("details") or {}, files=doc.get("files") or {})
    else:
        board = run.score(cfg, agents=args.agents)
    result = triage(cfg, board, score=lambda c, only: run.score(c, only=only, agents=args.agents))
    date = _dt.date.today().isoformat()
    page = write_page(result, Path(args.out or f"red-promises-{date}.md"), date)
    if args.json:
        print(json.dumps({"page": str(page), "counts": result.counts, "resting": resting(result),
                          "rows": [asdict(r) for r in result.rows]}, indent=1))
    else:
        print(f"wrote {page}")
        print("  ".join(f"{k}: {v}" for k, v in sorted(result.counts.items())) or "no reds")
    return 0 if resting(result) else 1


if __name__ == "__main__":
    sys.exit(main())
