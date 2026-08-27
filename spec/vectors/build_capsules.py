#!/usr/bin/env python3
"""Build the golden `.plur` capsule fixtures.

§6 of the standard is marked STABLE and describes a binary format down to the
byte. Nothing in the codebase produces one: `packages/core/src/capsule.ts` can
read and write capsules, and grep finds no caller outside its own tests. So the
format is specified, implemented, and has never been exercised against bytes
somebody else produced.

`plur-ai/encode#30` would make Encode the first producer of a capsule anywhere.
These fixtures are what it can build against — hex written by Python from the
document, not emitted by the TypeScript it is meant to interoperate with.

The negative cases matter more than the positive one. §6.7 lists the checks a
reader MUST perform, and a check nobody has seen fail is not a check.

Usage:
    python3 build_capsules.py
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "capsules"

MAGIC = b"PLUR"
FORMAT_VERSION_V1 = 0x0001
FLAG_SIGNED = 0x0001
FLAG_COMPRESSED = 0x0002
PREAMBLE_LEN = 12


def header(payload: bytes, *, compression: str = "none") -> dict:
    """A minimal §6.4 header describing this payload."""
    return {
        "schema": "plur.capsule/1",
        "product_type": "engram-pack",
        "manifest_summary": {
            # §6.4 marks engram_count REQUIRED, int >= 0. Omitting it was the
            # first thing these fixtures caught — the reference rejected the
            # "valid" capsule, and it was right to. Left as a comment because
            # the omission is easy to repeat: nothing about a *summary* suggests
            # a count is mandatory in it.
            "name": "conformance-vector",
            "version": "1.0.0",
            "creator": "local:spec",
            "engram_count": 1,
        },
        "payload": {
            "compression": compression,
            "size_compressed": len(payload),
            "size_uncompressed": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        },
        "created_at": "2026-08-27T00:00:00Z",
        "producer": {"tool": "spec-vectors", "version": "1.0.0"},
        "signer": None,
    }


def capsule(
    payload: bytes,
    *,
    magic: bytes = MAGIC,
    version: int = FORMAT_VERSION_V1,
    flags: int = 0,
    header_obj: dict | None = None,
    header_len_override: int | None = None,
    truncate: int | None = None,
) -> bytes:
    """Assemble a capsule, with every field overridable so negatives are exact."""
    hdr = json.dumps(header_obj if header_obj is not None else header(payload),
                     separators=(",", ":")).encode("utf-8")
    declared = header_len_override if header_len_override is not None else len(hdr)
    out = magic + struct.pack("<HHI", version, flags, declared) + hdr + payload
    return out[:truncate] if truncate is not None else out


PAYLOAD = b"engrams:\n  - id: ENG-PACK-VEC-001\n    statement: \"A capsule payload\"\n"

CASES: list[tuple[str, bytes, str, str]] = [
    (
        "valid-minimal",
        capsule(PAYLOAD),
        "accept",
        "A well-formed v1 capsule with no flags set. Every §6.7 check passes.",
    ),
    (
        "bad-magic",
        capsule(PAYLOAD, magic=b"XXXX"),
        "reject",
        "§6.7 step 2: the first four bytes are not 50 4c 55 52. A reader MUST refuse "
        "rather than attempt to parse what follows.",
    ),
    (
        "unknown-format-version",
        capsule(PAYLOAD, version=0x0002),
        "reject",
        "§10.3 rule 3: a reader MUST reject an unknown FormatVersion rather than "
        "guess. This is what keeps the version space usable later.",
    ),
    (
        "reserved-flag-set",
        capsule(PAYLOAD, flags=0x0004),
        "reject",
        "§10.3 rule 4: reserved flag bits (2-15, mask 0xfffc) MUST be zero on write "
        "and MUST cause rejection on read. Accepting one now would make the bit "
        "unusable for its eventual meaning.",
    ),
    (
        "declared-size-mismatch",
        capsule(PAYLOAD, header_obj={**header(PAYLOAD), "payload": {
            **header(PAYLOAD)["payload"], "size_compressed": 999999}}),
        "reject",
        "§6.7: the header's declared payload size does not match the bytes present.",
    ),
    (
        "sha256-mismatch",
        capsule(PAYLOAD, header_obj={**header(PAYLOAD), "payload": {
            **header(PAYLOAD)["payload"], "sha256": "0" * 64}}),
        "reject",
        "§6.7 step 10 and §8: the recomputed payload hash does not match the header. "
        "A receiver MUST refuse to act on it.",
    ),
    (
        "truncated-preamble",
        capsule(PAYLOAD)[:8],
        "reject",
        "§6.7 step 1: fewer than 12 bytes, so there is not even a preamble to read.",
    ),
    (
        "truncated-payload",
        capsule(PAYLOAD, truncate=PREAMBLE_LEN + 40),
        "reject",
        "§6.7: the payload region underflows what the header declares.",
    ),
    (
        "compressed-flag-without-compression",
        capsule(PAYLOAD, flags=FLAG_COMPRESSED),
        "reject",
        "§6.7 step 11: COMPRESSED is set but the header says compression:none. The "
        "flag and the descriptor MUST agree; a reader cannot know which to believe.",
    ),
    (
        "signed-flag-without-signature",
        capsule(PAYLOAD, flags=FLAG_SIGNED),
        "reject",
        "§6.8 step 4 and §7: SIGNED is set with no 64-byte trailer and signer:null. "
        "v1 producers MUST NOT set SIGNED at all, since the scheme is RESERVED — so "
        "a reader seeing it has an ambiguous envelope and refuses.",
    ),
]


def main() -> int:
    OUT.mkdir(exist_ok=True)
    index = []
    for name, data, expect, note in CASES:
        (OUT / f"{name}.plur").write_bytes(data)
        index.append({
            "capsule": f"{name}.plur",
            "expect": expect,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "note": note,
        })
    (HERE / "capsules.json").write_text(json.dumps({
        "note": "Golden .plur capsule fixtures, written by Python from §6 of the "
                "standard. §6 is STABLE and has no producer or consumer in the "
                "codebase, so these are the first bytes it has been asked to agree "
                "with. The negative cases are the point: §6.7 lists checks a reader "
                "MUST perform, and a check nobody has seen fail is not a check.",
        "standard": "ENGRAM-STANDARD-v1.md §6",
        "capsules": index,
    }, indent=2) + "\n")
    print(f"Built {len(index)} capsule fixtures into {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
