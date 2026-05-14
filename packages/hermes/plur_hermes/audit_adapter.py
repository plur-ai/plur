"""Hermes runtime — audit adapter (Path B: JSON bridge).

Emits Hermes's "working memory" as JSON for the TS `plur audit` CLI to consume.

Architecture decision (2026-05-10): Path B chosen over Path A. Path A would
re-implement the audit classifier in @plur-ai/core with a Python binding, but:
  - Hermes's working-memory schema is not yet stable
  - The classifier is ~100 lines of TypeScript; not worth a cross-language port
  - JSON-over-subprocess is the standard cross-runtime pattern in Datacore

Workflow:
  python -m plur_hermes.audit_adapter emit > /tmp/hermes-memory.json
  plur audit --from-json /tmp/hermes-memory.json

Working memory source (2026-05-12 implementation):
  ~/.plur/meta-pipeline-{session_id}.json — multi-turn engram extraction
  pipeline state. Each file represents one Hermes session that is mid-pipeline
  or recently completed (24h TTL). Each file's `engrams` and `meta_engrams`
  fields are candidate memory entries — they're proto-engrams not yet
  promoted to the global engram store, so they're exactly the "in-flight
  working memory" the audit cares about.

The schema MUST match MemoryEntry in packages/cli/src/commands/audit.ts:
  {source, topic, description, body, filepath, ageDays}
"""

from __future__ import annotations

import glob
import json
import os
import sys
import time
from pathlib import Path
from typing import TypedDict


class HermesMemoryEntry(TypedDict):
    source: str
    topic: str
    description: str
    body: str
    filepath: str
    ageDays: float


def _plur_root() -> Path:
    """Where Hermes meta-pipeline state files live (defaults to ~/.plur)."""
    p = os.environ.get("PLUR_PATH") or os.path.expanduser("~/.plur")
    return Path(p)


def _entry_from_pipeline_state(filepath: Path) -> HermesMemoryEntry | None:
    """Convert one meta-pipeline-*.json file into a MemoryEntry.

    Each pipeline state has stage, engrams[], meta_engrams[], pending_prompts[].
    We summarize the engram statements as the body so the audit's recall can
    match them against the global engram store. If meta_engrams[] is non-empty,
    those are the higher-priority candidates (already abstracted).
    """
    try:
        data = json.loads(filepath.read_text())
    except (OSError, json.JSONDecodeError):
        return None

    session_id = data.get("session_id", filepath.stem)
    stage = data.get("stage", 0)
    engrams = data.get("engrams", []) or []
    meta_engrams = data.get("meta_engrams", []) or []
    created_at = data.get("created_at", filepath.stat().st_mtime)

    # Prefer meta_engrams (already higher-order) if present, else proto-engrams.
    items = meta_engrams if meta_engrams else engrams
    if not items:
        # Empty pipeline state — nothing to audit.
        return None

    # Body: concatenated statements (truncated). The audit's recall query
    # uses (topic + description), so we keep statements in body for context.
    statements = []
    for e in items[:10]:
        if isinstance(e, dict):
            s = e.get("statement") or e.get("text") or ""
            if s:
                statements.append(s[:200])
    body = "\n".join(statements)[:800]
    description = f"stage {stage}, {len(meta_engrams)} meta + {len(engrams)} proto engrams"

    age_days = (time.time() - created_at) / 86400.0
    return {
        "source": f"hermes:{session_id[:12]}",
        "topic": f"meta-pipeline session {session_id[:12]}",
        "description": description,
        "body": body,
        "filepath": str(filepath),
        "ageDays": age_days,
    }


def load_hermes_memory() -> list[HermesMemoryEntry]:
    """Enumerate Hermes meta-pipeline working-memory entries.

    Scans ~/.plur/meta-pipeline-*.json (24h TTL per meta_pipeline.py).
    Returns one MemoryEntry per pipeline state with at least one
    engram or meta_engram. Empty/stale pipelines are skipped silently.
    """
    pattern = str(_plur_root() / "meta-pipeline-*.json")
    entries: list[HermesMemoryEntry] = []
    for fp_str in glob.glob(pattern):
        fp = Path(fp_str)
        entry = _entry_from_pipeline_state(fp)
        if entry is not None:
            entries.append(entry)
    return entries


def entry_from_file(filepath: Path, source_tag: str = "hermes") -> HermesMemoryEntry:
    """Helper for adapter implementations — build an entry from a file path."""
    body = filepath.read_text() if filepath.exists() else ""
    age_days = (time.time() - filepath.stat().st_mtime) / 86400.0 if filepath.exists() else 0.0
    return {
        "source": source_tag,
        "topic": filepath.stem,
        "description": "",
        "body": body[:800],
        "filepath": str(filepath),
        "ageDays": age_days,
    }


def main() -> int:
    """CLI: `python -m plur_hermes.audit_adapter emit` writes JSON to stdout."""
    if len(sys.argv) > 1 and sys.argv[1] == "emit":
        entries = load_hermes_memory()
        json.dump(entries, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    sys.stderr.write("Usage: python -m plur_hermes.audit_adapter emit\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
