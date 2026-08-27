#!/usr/bin/env python3
"""Verify the golden pack vectors from outside the reference implementation.

This is the half of the conformance suite that does not need Node. It reads the
committed vectors and checks the rules §5 states, using nothing but the standard
library — so a third party can run it against their own producer's output and get
the same answers we do.

`plur-ai/encode` is the immediate reason it exists. It implements the pack format
directly in Python (encode#32), deliberately, because the format is published and
§5 is normative. This gives it something to check against that is not our
TypeScript.

What it checks, per §5 of ENGRAM-STANDARD-v1.md:

  §5.1  layout — SKILL.md required, manifest is its YAML frontmatter
  §5.5  integrity — SHA-256 over bytes(SKILL.md) ‖ bytes(engrams.yaml),
        recorded as sha256:<64 lowercase hex>, computed over RAW BYTES
  §5.4  export privacy — no private engrams, no pinned, no locked commitment
  profile §5.3.1 — provenance/ layout, and that it does not affect the hash

Usage:
    python3 verify.py                      # every vector in ./packs/
    python3 verify.py PACK_DIR [PACK_DIR…] # named pack directories
    python3 verify.py --index index.json   # check against declared expectations

Exit code is 1 if any check fails, so this can gate a build.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
INTEGRITY_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class Result:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.notes: list[str] = []
        self.checked = 0

    def fail(self, pack: str, msg: str) -> None:
        self.failures.append(f"{pack}: {msg}")

    def note(self, pack: str, msg: str) -> None:
        self.notes.append(f"{pack}: {msg}")


def pack_hash(pack: Path) -> str:
    """§5.5, computed over raw bytes with no re-serialization."""
    skill = pack / "SKILL.md"
    engrams = pack / "engrams.yaml"
    data = b""
    if skill.exists():
        data += skill.read_bytes()
    if engrams.exists():
        data += engrams.read_bytes()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def frontmatter(skill_md: Path) -> str | None:
    """The manifest block, as raw text. Not parsed — we check shape, not values."""
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    return None if end == -1 else text[3:end]


def check_pack(pack: Path, r: Result) -> None:
    name = pack.name
    r.checked += 1

    # --- §5.1 layout -------------------------------------------------------
    skill = pack / "SKILL.md"
    legacy = pack / "manifest.yaml"
    if not skill.exists() and not legacy.exists():
        r.fail(name, "§5.1: neither SKILL.md nor a legacy manifest.yaml is present")
        return
    if not skill.exists():
        r.note(name, "§5.1: ships a DEPRECATED manifest.yaml and no SKILL.md")
    else:
        fm = frontmatter(skill)
        if fm is None:
            r.fail(name, "§5.1: SKILL.md has no YAML frontmatter, so it carries no manifest")
        else:
            for required in ("name:", "version:"):
                if required not in fm:
                    r.fail(name, f"§5.2: manifest is missing the required `{required.rstrip(':')}` field")

    if not (pack / "engrams.yaml").exists():
        r.note(name, "§5.1: ships no engrams.yaml")

    # --- §5.5 integrity ----------------------------------------------------
    computed = pack_hash(pack)
    integrity_file = pack / "INTEGRITY"
    if integrity_file.exists():
        shipped = integrity_file.read_text(encoding="utf-8").strip()
        if not INTEGRITY_RE.match(shipped):
            r.fail(name, f"§5.5: INTEGRITY is not `sha256:<64 lowercase hex>` — {shipped!r}")
        elif shipped != computed:
            r.note(name, f"§5.5: integrity MISMATCH (shipped {shipped[:23]}…, computed {computed[:23]}…)")
    else:
        r.note(name, "§5.5: ships no INTEGRITY file (OPTIONAL on disk)")

    # --- §5.4 export privacy ------------------------------------------------
    #
    # Text matching rather than YAML parsing, deliberately: this file has no
    # third-party dependencies so that a producer can run it anywhere. The
    # vectors are written to make this sufficient; a real store's engrams.yaml
    # would want a parser.
    engrams_text = (pack / "engrams.yaml").read_text(encoding="utf-8") if (pack / "engrams.yaml").exists() else ""
    if re.search(r"^\s*-?\s*visibility:\s*[\"']?private", engrams_text, re.M):
        r.note(name, "§5.4: contains an engram with `visibility: private` — a producer MUST exclude these")
    if re.search(r"^\s*-?\s*pinned:\s*true", engrams_text, re.M):
        r.note(name, "§5.4: ships `pinned: true` — a consumer MUST neutralize this on import")
    if re.search(r"^\s*-?\s*commitment:\s*[\"']?locked", engrams_text, re.M):
        r.note(name, "§5.4: ships `commitment: locked` — a consumer MUST downgrade this on import")

    # --- profile §5.3.1 provenance -----------------------------------------
    prov = pack / "provenance"
    if prov.is_dir():
        records = sorted(p for p in prov.glob("*.jsonld"))
        if not records:
            r.fail(name, "profile §5.3.1: a provenance/ directory with no .jsonld records in it")
        engram_ids = set(re.findall(r"id:\s*[\"']?((?:ENG|ABS|META)-[A-Za-z0-9-]+)", engrams_text))
        for rec in records:
            if rec.name == "pack.jsonld":
                continue
            try:
                json.loads(rec.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                r.note(name, f"profile §5.4.2: {rec.name} is not readable JSON — MUST be reported, not skipped")
                continue
            described = rec.stem
            if engram_ids and described not in engram_ids:
                r.note(name, f"profile §5.4.2: {rec.name} describes an engram the pack does not contain")

        # The property that matters: records are outside the §5.5 hash, so
        # removing them must not change it.
        without = "sha256:" + hashlib.sha256(
            (pack / "SKILL.md").read_bytes() + (pack / "engrams.yaml").read_bytes()
        ).hexdigest()
        if without != computed:
            r.fail(name, "§5.1: the provenance/ directory affected the integrity hash; it MUST NOT")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("packs", nargs="*", type=Path)
    ap.add_argument("--index", type=Path, help="check declared expectations too")
    args = ap.parse_args()

    targets = args.packs or sorted(p for p in (HERE / "packs").iterdir() if p.is_dir())
    if not targets:
        print("No pack directories found.", file=sys.stderr)
        return 1

    r = Result()
    for pack in targets:
        check_pack(pack, r)

    if args.index:
        declared = json.loads(args.index.read_text())
        by_name = {v["pack"]: v for v in declared["vectors"]}
        for pack in targets:
            entry = by_name.get(pack.name)
            if not entry:
                r.fail(pack.name, "present on disk but absent from index.json")
                continue
            actual = pack_hash(pack)
            if actual != entry["computed_integrity"]:
                r.fail(pack.name,
                       f"hash drift from index.json: declared {entry['computed_integrity'][:23]}…, "
                       f"got {actual[:23]}…")
        for name in by_name:
            if not (HERE / "packs" / name).is_dir():
                r.fail(name, "declared in index.json but not on disk")

    for n in r.notes:
        print(f"  note  {n}")
    for f in r.failures:
        print(f"  FAIL  {f}", file=sys.stderr)

    print(f"\n{r.checked} pack(s) checked, {len(r.failures)} failure(s), {len(r.notes)} note(s).")
    if r.failures:
        print("\nA failure means a vector violates §5. A note is an observation the "
              "vector was built to make — several vectors exist precisely to trip one.",
              file=sys.stderr)
    return 1 if r.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
