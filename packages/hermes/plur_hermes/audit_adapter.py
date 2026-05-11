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

The schema MUST match MemoryEntry in packages/cli/src/commands/audit.ts:
  {source, topic, description, body, filepath, ageDays}

Status: scan logic is STUB. The emit/JSON-bridge pattern is wired and ready
once we identify Hermes's working-memory sources (likely meta_pipeline state,
learner.py outputs, hermes session journals).
"""

from __future__ import annotations

import json
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


def load_hermes_memory() -> list[HermesMemoryEntry]:
    """Enumerate Hermes working-memory entries.

    TODO: implement once Hermes session/state schema is stable. Reference:
    packages/cli/src/commands/audit.ts loadClaudeCodeMemory() for the working
    Claude Code adapter — same shape, different source enumeration.

    Candidate sources to scan:
      - plur_hermes/meta_pipeline.py state files
      - plur_hermes/learner.py outputs (pre-engram corrections)
      - hermes session journals (if/when added)
    """
    return []


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
