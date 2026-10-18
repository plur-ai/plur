#!/usr/bin/env python3
"""Check a gold set before it is frozen. Written separately from the labeller's own check.

    python3 evals/gold/check.py evals/gold/recall-v1 [--other <holdout dir>]
    python3 evals/gold/check.py --dedup evals/gold/dedup-v2 --same-pairs-as evals/gold/recall-v1

The second form checks a duplicate-checker pair set with three labels (duplicate,
supersede, distinct; dedup-v2/LABELLER-CHECKLIST.md): 60 pairs, unique ids, no
other label, at least 20 duplicate and 20 supersede and one distinct, and the
same pair texts as the frozen set it relabels. Fewer than 20 distinct pairs is
printed as a warning: that rate is not yet measurable.

Fails (exit 1) when a count is off, an id is unknown or repeated, a paraphrase
query shares a content word with the memory it should find (then it tests
keywords, not meaning), a lexical query shares none, or the two sets overlap.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

import yaml

STOP = set("""a an and are as at be because by can do does for from get gets has have how i in
into is it its me my not of on or our should so than that the their them then there these this
to use used uses using was we what when where which who why will with without you your""".split())

WANT = {"memories": 150, "queries": 80, "pairs": 60, "tasks": 30}


def words(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w in STOP or len(w) < 3:
            continue
        for suffix in ("ing", "ed", "es", "s"):
            if w.endswith(suffix) and len(w) - len(suffix) >= 3:
                w = w[: -len(suffix)]
                break
        out.add(w)
    return out


def load(d: Path) -> dict:
    return {
        "memories": yaml.safe_load((d / "corpus.yaml").read_text())["memories"],
        "queries": yaml.safe_load((d / "queries.yaml").read_text())["queries"],
        "pairs": yaml.safe_load((d / "dedup_pairs.yaml").read_text())["pairs"],
        "tasks": yaml.safe_load((d / "inject_tasks.yaml").read_text())["tasks"],
    }


def check(d: Path) -> list[str]:
    s = load(d)
    errs = []
    for k, n in WANT.items():
        if len(s[k]) != n:
            errs.append(f"{k}: {len(s[k])}, expected {n}")
        dup = [i for i, c in Counter(x["id"] for x in s[k]).items() if c > 1]
        if dup:
            errs.append(f"{k}: repeated ids {dup}")
    mem = {m["id"]: m for m in s["memories"]}
    if len({m["statement"] for m in s["memories"]}) != len(mem):
        errs.append("corpus: two memories have the same statement")
    kinds = Counter(q["kind"] for q in s["queries"])
    if kinds != Counter({"lexical": 40, "paraphrase": 40}):
        errs.append(f"queries: kinds {dict(kinds)}, expected 40 lexical / 40 paraphrase")
    for q in s["queries"]:
        if not q["relevant"] or any(r not in mem for r in q["relevant"]):
            errs.append(f"{q['id']}: relevant {q['relevant']} names an unknown memory")
            continue
        shared = words(q["query"]) & set().union(*(words(mem[r]["statement"]) for r in q["relevant"]))
        if q["kind"] == "paraphrase" and shared:
            errs.append(f"{q['id']} (paraphrase) shares {sorted(shared)} with its memory")
        if q["kind"] == "lexical" and not shared:
            errs.append(f"{q['id']} (lexical) shares no word with its memory")
    labels = Counter(p["label"] for p in s["pairs"])
    if set(labels) != {"duplicate", "distinct"} or min(labels.values()) < 20:
        errs.append(f"pairs: labels {dict(labels)}, both classes need at least 20")
    for t in s["tasks"]:
        ids = t["must_include"] + t["must_exclude"]
        if not t["must_include"] or any(i not in mem for i in ids):
            errs.append(f"{t['id']}: names an unknown memory or includes nothing")
        if set(t["must_include"]) & set(t["must_exclude"]):
            errs.append(f"{t['id']}: a memory is both included and excluded")
    return errs


DEDUP_LABELS = {"duplicate", "supersede", "distinct"}


def check_dedup(d: Path, same_as: Path | None) -> tuple[list[str], list[str]]:
    pairs = yaml.safe_load((d / "dedup_pairs.yaml").read_text())["pairs"]
    errs, warns = [], []
    if len(pairs) != WANT["pairs"]:
        errs.append(f"pairs: {len(pairs)}, expected {WANT['pairs']}")
    dup = [i for i, c in Counter(p["id"] for p in pairs).items() if c > 1]
    if dup:
        errs.append(f"pairs: repeated ids {dup}")
    labels = Counter(p.get("label") for p in pairs)
    unknown = sorted(str(k) for k in labels if k not in DEDUP_LABELS)
    if unknown:
        errs.append(f"pairs: unknown labels {unknown}")
    for k, least in (("duplicate", 20), ("supersede", 20), ("distinct", 1)):
        if labels.get(k, 0) < least:
            errs.append(f"pairs: {labels.get(k, 0)} {k}, at least {least} needed")
    if 0 < labels.get("distinct", 0) < 20:
        warns.append(f"warning: only {labels['distinct']} distinct pairs; the false-merge rate is not measurable until there are 20")
    if same_as is not None:
        old = {p["id"]: (p["existing"], p["incoming"]) for p in yaml.safe_load((same_as / "dedup_pairs.yaml").read_text())["pairs"]}
        new = {p["id"]: (p["existing"], p["incoming"]) for p in pairs}
        if old != new:
            changed = sorted(i for i in old.keys() | new.keys() if old.get(i) != new.get(i))
            errs.append(f"pairs: texts differ from {same_as} for {changed[:10]} (a relabel changes labels only)")
    return errs, warns


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="?")
    ap.add_argument("--other", help="a second set that must not overlap this one")
    ap.add_argument("--dedup", help="check a three-label duplicate-checker pair set instead")
    ap.add_argument("--same-pairs-as", help="with --dedup: the frozen set whose pair texts must be kept")
    a = ap.parse_args()
    if a.dedup:
        errs, warns = check_dedup(Path(a.dedup), Path(a.same_pairs_as) if a.same_pairs_as else None)
        for line in errs + warns:
            print(line)
        print("ok" if not errs else f"{len(errs)} problem(s)")
        return 1 if errs else 0
    if not a.dir:
        ap.error("a set directory or --dedup is required")
    errs = check(Path(a.dir))
    if a.other:
        errs += [f"other: {e}" for e in check(Path(a.other))]
        mine, theirs = load(Path(a.dir)), load(Path(a.other))
        both = {m["statement"] for m in mine["memories"]} & {m["statement"] for m in theirs["memories"]}
        qboth = {q["query"] for q in mine["queries"]} & {q["query"] for q in theirs["queries"]}
        if both or qboth:
            errs.append(f"the sets overlap: {len(both)} memories, {len(qboth)} queries")
    for e in errs:
        print(e)
    print("ok" if not errs else f"{len(errs)} problem(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
