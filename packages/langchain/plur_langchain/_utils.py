"""Shared utilities for plur-langchain."""
from __future__ import annotations

import os

from plur_ai import Plur  # type: ignore[import]


def make_bridge(plur_path: str | None = None) -> Plur:
    """Return a Plur client, respecting PLUR_PATH env var."""
    path = plur_path or os.environ.get("PLUR_PATH")
    return Plur(path=path)


def inject_to_text(bridge: Plur, task: str, budget: int = 1500) -> str:
    """Inject relevant engrams and return a formatted context string."""
    try:
        result = bridge.inject(task, budget=budget)
    except Exception:
        return ""
    sections = [
        s for s in (
            result.get("directives", ""),
            result.get("constraints", ""),
            result.get("consider", ""),
        )
        if s and s.strip()
    ]
    return "\n".join(sections)
