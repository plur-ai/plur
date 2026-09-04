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

**Every rejection names its reason**, and the reason is asserted. A fixture that
is refused for a reason other than the one it was built to trigger proves
nothing about that check — the first `signed-flag-without-signature` fixture
failed as a payload size mismatch, and `truncated-payload` was cut inside the
header, so the two checks they named were never reached by any fixture at all.
`reason` is a regular expression the reader's error MUST match.

Usage:
    python3 build_capsules.py            # rebuild into ./capsules/ and capsules.json
    python3 build_capsules.py --check    # rebuild into a temp dir and diff; exit 1 on drift
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "capsules"
INDEX = HERE / "capsules.json"

MAGIC = b"PLUR"
FORMAT_VERSION_V1 = 0x0001
FLAG_SIGNED = 0x0001
FLAG_COMPRESSED = 0x0002
PREAMBLE_LEN = 12
ED25519_SIG_LEN = 64

SIGNER = {"algo": "ed25519", "public_key": "k" * 44, "key_id": "spec/vectors"}


def header(payload: bytes, *, compression: str = "none", signer: dict | None = None) -> dict:
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
        "signer": signer,
    }


def header_bytes(header_obj: dict) -> bytes:
    return json.dumps(header_obj, separators=(",", ":")).encode("utf-8")


def capsule(
    payload: bytes,
    *,
    magic: bytes = MAGIC,
    version: int = FORMAT_VERSION_V1,
    flags: int = 0,
    header_obj: dict | None = None,
    header_len_override: int | None = None,
    trailer: bytes = b"",
    truncate: int | None = None,
) -> bytes:
    """Assemble a capsule, with every field overridable so negatives are exact."""
    hdr = header_bytes(header_obj if header_obj is not None else header(payload))
    declared = header_len_override if header_len_override is not None else len(hdr)
    out = magic + struct.pack("<HHI", version, flags, declared) + hdr + payload + trailer
    return out[:truncate] if truncate is not None else out


PAYLOAD = b"engrams:\n  - id: ENG-PACK-VEC-001\n    statement: \"A capsule payload\"\n"
# Shorter than one Ed25519 signature, so a SIGNED capsule that ships it with no
# trailer has a payload region that underflows (§6.7 step 8).
SHORT_PAYLOAD = b"engrams: []\n"
assert len(SHORT_PAYLOAD) < ED25519_SIG_LEN
HEADER_LEN = len(header_bytes(header(PAYLOAD)))

# (name, bytes, expect, reason, note). `reason` is a JavaScript-compatible
# regular expression the reader's rejection message MUST match; None for accept.
CASES: list[tuple[str, bytes, str, str | None, str]] = [
    (
        "valid-minimal",
        capsule(PAYLOAD),
        "accept",
        None,
        "A well-formed v1 capsule with no flags set. Every §6.7 check passes.",
    ),
    (
        "bad-magic",
        capsule(PAYLOAD, magic=b"XXXX"),
        "reject",
        "bad magic",
        "§6.7 step 3: the first four bytes are not 50 4c 55 52. A reader MUST refuse "
        "rather than attempt to parse what follows.",
    ),
    (
        "unknown-format-version",
        capsule(PAYLOAD, version=0x0002),
        "reject",
        "unsupported FormatVersion",
        "§6.7 step 4 and §10.3 rule 3: a reader MUST reject an unknown FormatVersion "
        "rather than guess. This is what keeps the version space usable later.",
    ),
    (
        "reserved-flag-set",
        capsule(PAYLOAD, flags=0x0004),
        "reject",
        "reserved flag bits",
        "§6.7 step 5 and §10.3 rule 4: reserved flag bits (2-15, mask 0xfffc) MUST be "
        "zero on write and MUST cause rejection on read. Accepting one now would make "
        "the bit unusable for its eventual meaning.",
    ),
    (
        "truncated-preamble",
        capsule(PAYLOAD)[:8],
        "reject",
        "truncated preamble",
        "§6.7 step 2: fewer than 12 bytes, so there is not even a preamble to read.",
    ),
    (
        "truncated-header",
        capsule(PAYLOAD, truncate=PREAMBLE_LEN + 40),
        "reject",
        "truncated header",
        "§6.7 step 7: HeaderLen promises more header bytes than the file holds. "
        "This is the case the first `truncated-payload` fixture actually exercised.",
    ),
    (
        "declared-size-mismatch",
        capsule(PAYLOAD, header_obj={**header(PAYLOAD), "payload": {
            **header(PAYLOAD)["payload"], "size_compressed": 999999}}),
        "reject",
        "payload size mismatch",
        "§6.7 step 9: the header's declared payload size does not match the bytes present.",
    ),
    (
        "truncated-payload",
        capsule(PAYLOAD, truncate=PREAMBLE_LEN + HEADER_LEN + 10),
        "reject",
        "payload size mismatch",
        "§6.7 step 9: the header is intact and the payload is cut short, so the bytes "
        "present are fewer than size_compressed declares. Without SIGNED the payload "
        "region cannot underflow (step 8); the shortfall is a size mismatch.",
    ),
    (
        "signed-payload-underflow",
        capsule(SHORT_PAYLOAD, flags=FLAG_SIGNED, header_obj=header(SHORT_PAYLOAD, signer=SIGNER)),
        "reject",
        "payload region underflow",
        "§6.7 step 8: SIGNED is set with a signer present, so the last 64 bytes are the "
        "trailer — and the file holds fewer than 64 bytes after the header. The payload "
        "region computes to a negative length and MUST be refused as an underflow.",
    ),
    (
        "sha256-mismatch",
        capsule(PAYLOAD, header_obj={**header(PAYLOAD), "payload": {
            **header(PAYLOAD)["payload"], "sha256": "0" * 64}}),
        "reject",
        "integrity mismatch",
        "§6.7 step 10 and §8: the recomputed payload hash does not match the header. "
        "A receiver MUST refuse to act on it.",
    ),
    (
        "compressed-flag-without-compression",
        capsule(PAYLOAD, flags=FLAG_COMPRESSED),
        "reject",
        "COMPRESSED flag",
        "§6.7 step 11: COMPRESSED is set but the header says compression:none. The "
        "flag and the descriptor MUST agree; a reader cannot know which to believe.",
    ),
    (
        "signed-flag-without-signature",
        capsule(PAYLOAD, flags=FLAG_SIGNED),
        "reject",
        "SIGNED flag \\(true\\) disagrees with header\\.signer \\(null\\)",
        "§6.7 step 7 and §6.8 step 4: SIGNED is set with signer:null and no 64-byte "
        "trailer. v1 producers MUST NOT set SIGNED at all, since the scheme is RESERVED "
        "(§7) — a reader seeing it has an ambiguous envelope and refuses for THAT reason, "
        "not for the size mismatch the flag causes downstream.",
    ),
    (
        "signer-without-signed-flag",
        capsule(PAYLOAD, header_obj=header(PAYLOAD, signer=SIGNER)),
        "reject",
        "SIGNED flag \\(false\\) disagrees with header\\.signer \\(present\\)",
        "§6.7 step 7 and §6.8 step 4, the other direction: a signer is named in the "
        "header and SIGNED is clear, so nothing says whether a trailer is present. "
        "Refused as the same ambiguous envelope.",
    ),
]


def capsules_document(index: list[dict]) -> str:
    return json.dumps({
        "note": "Golden .plur capsule fixtures, written by Python from §6 of the "
                "standard. §6 is STABLE and has no producer or consumer in the "
                "codebase, so these are the first bytes it has been asked to agree "
                "with. The negative cases are the point: §6.7 lists checks a reader "
                "MUST perform, and a check nobody has seen fail is not a check. Every "
                "rejection carries the `reason` the reader MUST give, as a regular "
                "expression, so a fixture refused for some other reason is a failure.",
        "standard": "ENGRAM-STANDARD-v1.md §6",
        "capsules": index,
    }, indent=2, ensure_ascii=False) + "\n"


def build(out: Path) -> list[dict]:
    out.mkdir(exist_ok=True)
    index = []
    for name, data, expect, reason, note in CASES:
        (out / f"{name}.plur").write_bytes(data)
        index.append({
            "capsule": f"{name}.plur",
            "expect": expect,
            "reason": reason,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "note": note,
        })
    return index


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir and fail on any difference, capsules.json included")
    args = ap.parse_args()

    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            fresh = Path(tmp) / "capsules"
            index = build(fresh)
            drift = []
            for path in sorted(fresh.iterdir()):
                committed = OUT / path.name
                if not committed.exists():
                    drift.append(f"missing from the repository: capsules/{path.name}")
                elif committed.read_bytes() != path.read_bytes():
                    drift.append(f"differs from the repository: capsules/{path.name}")
            for path in sorted(OUT.iterdir()) if OUT.exists() else []:
                if path.is_file() and not (fresh / path.name).exists():
                    drift.append(f"in the repository but not rebuilt: capsules/{path.name}")
            if not INDEX.exists():
                drift.append("missing from the repository: capsules.json")
            elif INDEX.read_text(encoding="utf-8") != capsules_document(index):
                drift.append("differs from the repository: capsules.json")
            if drift:
                print("Capsule drift:", file=sys.stderr)
                for d in drift:
                    print(f"  {d}", file=sys.stderr)
                print("\nRun `python3 build_capsules.py` if the change was intended.", file=sys.stderr)
                return 1
            print("Capsules and capsules.json match what this script builds.")
            return 0

    index = build(OUT)
    INDEX.write_text(capsules_document(index), encoding="utf-8")
    print(f"Built {len(index)} capsule fixtures into {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
