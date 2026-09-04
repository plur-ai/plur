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
  §5.4  export privacy — declared private engrams, pinned, locked commitment
  profile §5.3.1 — provenance/ layout, and that it does not affect the hash

With `--index`, the declarations in index.json are checked AGAINST the fixture
bytes: the integrity verdict, what `expect` requires of the contents, and every
count a consumer must report. A count edited by hand, or a fixture that no longer
shows what its entry claims, is a failure — not a note. With `--capsules`, each
`.plur` fixture's size and SHA-256 are checked against capsules.json, so a binary
edit that would be invisible in review is caught.

Usage:
    python3 verify.py                      # every vector in ./packs/
    python3 verify.py PACK_DIR [PACK_DIR…] # named pack directories
    python3 verify.py --index index.json   # check the declared expectations too
    python3 verify.py --capsules capsules.json

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
ENGRAM_ID_RE = re.compile(r"^(?:ENG|ABS|META)-[A-Za-z0-9-]+$")


class Result:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.notes: list[str] = []
        self.checked = 0

    def fail(self, pack: str, msg: str) -> None:
        self.failures.append(f"{pack}: {msg}")

    def note(self, pack: str, msg: str) -> None:
        self.notes.append(f"{pack}: {msg}")


class Findings:
    """What the fixture bytes show, for comparison with what index.json declares."""

    def __init__(self) -> None:
        self.integrity_status = "absent"
        self.engram_count = 0
        self.declared_private = 0
        self.omitted_visibility = 0
        self.pinned = 0
        self.locked = 0
        self.provenance_dir = False
        self.provenance_records = 0
        self.orphan_records = 0
        self.unreadable_records = 0
        self.root_fields: set[str] = set()


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


def engram_blocks(engrams_text: str) -> list[str]:
    """Split a store document into per-engram text blocks, on `- id:` lines.

    Text splitting rather than YAML parsing, deliberately: this file has no
    third-party dependencies so that a producer can run it anywhere. The vectors
    are written to make this sufficient; a real store's engrams.yaml would want
    a parser.
    """
    blocks: list[str] = []
    current: list[str] = []
    for line in engrams_text.splitlines():
        if re.match(r"^\s*-\s+id:", line):
            if current:
                blocks.append("\n".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def check_pack(pack: Path, r: Result) -> Findings:
    name = pack.name
    r.checked += 1
    f = Findings()

    # --- §5.1 layout -------------------------------------------------------
    skill = pack / "SKILL.md"
    legacy = pack / "manifest.yaml"
    if not skill.exists() and not legacy.exists():
        r.fail(name, "§5.1: neither SKILL.md nor a legacy manifest.yaml is present")
        return f
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
            f.root_fields = {m.group(1) for m in re.finditer(r"^([A-Za-z0-9_-]+):", fm, re.M)}

    if not (pack / "engrams.yaml").exists():
        r.note(name, "§5.1: ships no engrams.yaml")

    # --- §5.5 integrity ----------------------------------------------------
    computed = pack_hash(pack)
    integrity_file = pack / "INTEGRITY"
    if integrity_file.exists():
        shipped = integrity_file.read_text(encoding="utf-8").strip()
        if not INTEGRITY_RE.match(shipped):
            r.fail(name, f"§5.5: INTEGRITY is not `sha256:<64 lowercase hex>` — {shipped!r}")
            f.integrity_status = "modified"
        elif shipped != computed:
            r.note(name, f"§5.5: integrity MISMATCH (shipped {shipped[:23]}…, computed {computed[:23]}…)")
            f.integrity_status = "modified"
        else:
            f.integrity_status = "ok"
    else:
        r.note(name, "§5.5: ships no INTEGRITY file (OPTIONAL on disk)")
        f.integrity_status = "absent"

    # --- §5.4 export privacy ------------------------------------------------
    engrams_text = (pack / "engrams.yaml").read_text(encoding="utf-8") if (pack / "engrams.yaml").exists() else ""
    blocks = engram_blocks(engrams_text)
    f.engram_count = len(blocks)
    for block in blocks:
        if re.search(r"^\s*(?:-\s+)?visibility:\s*[\"']?private", block, re.M):
            f.declared_private += 1
        elif not re.search(r"^\s*(?:-\s+)?visibility:", block, re.M):
            f.omitted_visibility += 1
        if re.search(r"^\s*(?:-\s+)?pinned:\s*true", block, re.M):
            f.pinned += 1
        if re.search(r"^\s*(?:-\s+)?commitment:\s*[\"']?locked", block, re.M):
            f.locked += 1
    if f.declared_private:
        r.note(name, f"§5.4: {f.declared_private} engram(s) DECLARE `visibility: private` — a producer MUST exclude these; "
                     "§5.6.1 step 2: a consumer MUST refuse the pack")
    if f.omitted_visibility:
        r.note(name, f"§5.6.1 step 2: {f.omitted_visibility} engram(s) carry no visibility — the consumer's default "
                     "makes them private; held and reported, not refused")
    if f.pinned:
        r.note(name, f"§5.4: ships `pinned: true` on {f.pinned} engram(s) — a consumer MUST neutralize this on import")
    if f.locked:
        r.note(name, f"§5.4: ships `commitment: locked` on {f.locked} engram(s) — a consumer MUST downgrade this on import")

    # --- profile §5.3.1 / §5.4.2 provenance --------------------------------
    prov = pack / "provenance"
    if prov.is_dir():
        f.provenance_dir = True
        records = sorted(p for p in prov.glob("*.jsonld") if p.is_file())
        if not records:
            r.fail(name, "profile §5.3.1: a provenance/ directory with no .jsonld records in it")
        engram_ids = set(re.findall(r"^\s*-\s+id:\s*[\"']?((?:ENG|ABS|META)-[A-Za-z0-9-]+)", engrams_text, re.M))
        for rec in records:
            if rec.name == "pack.jsonld":
                continue
            # Orphans are decided by NAME and never opened (profile §5.4.2):
            # whatever the file says is about an engram that is not here.
            if rec.stem not in engram_ids:
                f.orphan_records += 1
                r.note(name, f"profile §5.4.2: {rec.name} describes an engram the pack does not contain")
                continue
            try:
                doc = json.loads(rec.read_text(encoding="utf-8"))
                readable = isinstance(doc, dict) and isinstance(doc.get("@graph"), list)
            except (json.JSONDecodeError, UnicodeDecodeError):
                readable = False
            if not readable:
                f.unreadable_records += 1
                r.note(name, f"profile §5.4.2: {rec.name} is not a readable record — MUST be reported, not skipped")
            else:
                f.provenance_records += 1

        # The property that matters: records are outside the §5.5 hash, so
        # removing them must not change it.
        #
        # Read the two files the same way pack_hash does — tolerating absence
        # rather than assuming it. A pack that ships provenance/ and no
        # engrams.yaml is malformed, but it must produce a diagnostic here, not
        # a traceback: this is the path a third party runs against a pack we did
        # not build, and an unhandled FileNotFoundError tells them nothing about
        # which pack failed or why.
        payload = b""
        for part in ("SKILL.md", "engrams.yaml"):
            part_file = pack / part
            if part_file.exists():
                payload += part_file.read_bytes()
            else:
                r.fail(name, f"§5.5: {part} is missing, so the integrity hash cannot be checked")
        without = "sha256:" + hashlib.sha256(payload).hexdigest()
        if without != computed:
            r.fail(name, "§5.1: the provenance/ directory affected the integrity hash; it MUST NOT")

    return f


EXPECTS = {"load", "reject", "load-with-report", "load-neutralized", "disputed"}


def check_declaration(name: str, entry: dict, f: Findings, r: Result) -> None:
    """index.json against the fixture. Every field the TypeScript side asserts
    is checked here too, from the bytes, so the two sides cannot drift apart
    without one of them saying so."""

    def want(field: str, default=0):
        return entry.get(field, default)

    expect = entry.get("expect")
    if expect not in EXPECTS:
        r.fail(name, f"index.json: unknown expect {expect!r}")
        return

    if entry.get("integrity_status") != f.integrity_status:
        r.fail(name, f"index.json declares integrity_status={entry.get('integrity_status')!r}, "
                     f"the fixture shows {f.integrity_status!r}")
    if entry.get("engram_count") != f.engram_count:
        r.fail(name, f"index.json declares engram_count={entry.get('engram_count')!r}, "
                     f"the fixture holds {f.engram_count}")

    # What `expect` requires of the contents (§5.6.1 steps 1 and 2).
    refusable = f.integrity_status == "modified" or f.declared_private > 0
    if expect == "reject" and not refusable:
        r.fail(name, "index.json expects `reject`, but the fixture has neither an integrity "
                     "mismatch nor a declared private engram — nothing §5.6.1 refuses")
    if expect != "reject" and refusable:
        r.fail(name, f"index.json expects `{expect}`, but the fixture has what §5.6.1 refuses "
                     f"(integrity {f.integrity_status}, {f.declared_private} declared private)")

    # The counts a consumer MUST report (§5.6.5, profile §5.4.2), all of them,
    # for every vector — a `load` vector that quietly ships `pinned` is a
    # declaration error, not a passing vector.
    neutral = want("neutralized", {"pinned": 0, "locked": 0})
    if not isinstance(neutral, dict) or set(neutral) != {"pinned", "locked"}:
        r.fail(name, f"index.json: neutralized must be {{pinned, locked}}, got {neutral!r}")
    else:
        if neutral["pinned"] != f.pinned:
            r.fail(name, f"index.json declares neutralized.pinned={neutral['pinned']}, the fixture ships {f.pinned}")
        if neutral["locked"] != f.locked:
            r.fail(name, f"index.json declares neutralized.locked={neutral['locked']}, the fixture ships {f.locked}")
    if expect == "load-neutralized" and f.pinned + f.locked == 0:
        r.fail(name, "index.json expects `load-neutralized` and the fixture ships nothing to neutralize")
    if expect in ("load", "disputed") and f.pinned + f.locked > 0:
        r.fail(name, f"index.json expects `{expect}` and the fixture ships pinned/locked fields")

    for field, actual in (
        ("held_private", f.omitted_visibility),
        ("orphan_records", f.orphan_records),
        ("unreadable_records", f.unreadable_records),
        ("provenance_records", f.provenance_records),
    ):
        if want(field) != actual:
            r.fail(name, f"index.json declares {field}={want(field)}, the fixture shows {actual}")
    if expect == "load-with-report" and not (f.omitted_visibility or f.orphan_records or f.unreadable_records):
        r.fail(name, "index.json expects `load-with-report` and the fixture has nothing to report")
    if expect == "load" and (f.omitted_visibility or f.orphan_records or f.unreadable_records):
        r.fail(name, "index.json expects `load` and the fixture has something a consumer MUST report")

    unknown = entry.get("preserves_unknown_field")
    if unknown is not None and unknown not in f.root_fields:
        r.fail(name, f"index.json says root field {unknown!r} must be preserved, but the manifest does not carry it")


def check_capsules(index_path: Path, r: Result) -> None:
    declared = json.loads(index_path.read_text(encoding="utf-8"))
    capsules_dir = index_path.parent / "capsules"
    names = set()
    for entry in declared["capsules"]:
        name = entry["capsule"]
        names.add(name)
        r.checked += 1
        path = capsules_dir / name
        if not path.is_file():
            r.fail(name, "declared in capsules.json but not on disk")
            continue
        data = path.read_bytes()
        if len(data) != entry["bytes"]:
            r.fail(name, f"capsules.json declares {entry['bytes']} bytes, the file holds {len(data)}")
        digest = hashlib.sha256(data).hexdigest()
        if digest != entry["sha256"]:
            r.fail(name, f"capsules.json declares sha256 {entry['sha256'][:16]}…, the file hashes to {digest[:16]}…")
        if entry["expect"] not in ("accept", "reject"):
            r.fail(name, f"capsules.json: unknown expect {entry['expect']!r}")
        if entry["expect"] == "reject" and not entry.get("reason"):
            r.fail(name, "capsules.json: a rejection MUST name its reason")
        if entry["expect"] == "accept" and entry.get("reason"):
            r.fail(name, "capsules.json: an accepted capsule has no rejection reason")
        # §6.7 step 3, checked from outside: every fixture but the bad-magic and
        # truncated-preamble ones starts with the magic.
        if len(data) >= 4 and data[:4] != b"PLUR" and "magic" not in name:
            r.fail(name, "does not start with the PLUR magic and is not the bad-magic fixture")
    if capsules_dir.is_dir():
        for path in sorted(capsules_dir.glob("*.plur")):
            if path.name not in names:
                r.fail(path.name, "present on disk but absent from capsules.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("packs", nargs="*", type=Path)
    ap.add_argument("--index", type=Path, help="check the declared expectations in index.json against the fixtures")
    ap.add_argument("--capsules", type=Path, help="check capsules.json against the .plur fixtures (size, sha256)")
    args = ap.parse_args()

    targets = args.packs or sorted(p for p in (HERE / "packs").iterdir() if p.is_dir())
    if not targets and not args.capsules:
        print("No pack directories found.", file=sys.stderr)
        return 1

    r = Result()
    findings: dict[str, Findings] = {}
    for pack in targets:
        findings[pack.name] = check_pack(pack, r)

    if args.index:
        declared = json.loads(args.index.read_text(encoding="utf-8"))
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
            check_declaration(pack.name, entry, findings[pack.name], r)
        for name in by_name:
            if not (args.index.parent / "packs" / name).is_dir():
                r.fail(name, "declared in index.json but not on disk")

    if args.capsules:
        check_capsules(args.capsules, r)

    for n in r.notes:
        print(f"  note  {n}")
    for failure in r.failures:
        print(f"  FAIL  {failure}", file=sys.stderr)

    print(f"\n{r.checked} fixture(s) checked, {len(r.failures)} failure(s), {len(r.notes)} note(s).")
    if r.failures:
        print("\nA failure means a vector violates §5, or index.json declares something the "
              "fixture does not show. A note is an observation the vector was built to "
              "make — several vectors exist precisely to trip one.",
              file=sys.stderr)
    return 1 if r.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
