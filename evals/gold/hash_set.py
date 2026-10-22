#!/usr/bin/env python3
"""The content hash of a label set, so a frozen set cannot change unnoticed.

    python3 evals/gold/hash_set.py <dir>                 # print the hash
    python3 evals/gold/hash_set.py <dir> --expect <hash> # exit 1 unless it matches

The hash covers every file's relative path and bytes, in sorted order. The private
holdout's hash is committed (holdout-recall-v1.sha256); it reveals nothing about the
labels, and nightly refuses to score a holdout that is not the pinned version.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path


def digest(d: Path) -> str:
    h = hashlib.sha256()
    files = sorted(p for p in d.rglob("*") if p.is_file() and not p.name.startswith("."))
    if not files:
        raise SystemExit(f"could not tell: {d} holds no files")
    for p in files:
        h.update(str(p.relative_to(d)).encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir")
    ap.add_argument("--expect", default=None)
    a = ap.parse_args(argv)
    got = digest(Path(a.dir))
    if a.expect is None:
        print(got)
        return 0
    if got != a.expect.strip():
        print(f"the label set in {a.dir} is not the pinned version (hash {got[:12]}..., pinned {a.expect.strip()[:12]}...)")
        return 1
    print("ok: the label set is the pinned version")
    return 0


if __name__ == "__main__":
    sys.exit(main())
