"""Shared utilities for plur-langchain."""
from __future__ import annotations

import os
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage

from plur_ai import Plur  # type: ignore[import]

from .learner import extract_learning_patterns


class PlurMemoryError(RuntimeError):
    """A memory operation failed; its result must not be treated as successful."""


def message_text(value: Any) -> str:
    """Extract text from supported message forms without copying image metadata."""
    if isinstance(value, BaseMessage):
        return value.text()
    if isinstance(value, list):
        return HumanMessage(content=value).text()
    return "" if value is None else str(value)


def learn_from_text(bridge: Plur, text: str, *, source: str, rationale: str) -> None:
    for statement in extract_learning_patterns(text):
        try:
            bridge.learn(statement, source=source, rationale=rationale)
        except Exception:
            raise PlurMemoryError("PLUR memory learning failed; persistence was not confirmed") from None


def make_bridge(plur_path: str | None = None) -> Plur:
    """Return a Plur client, respecting PLUR_PATH env var."""
    path = plur_path or os.environ.get("PLUR_PATH")
    return Plur(path=path)


def inject_to_text(bridge: Plur, task: str, budget: int = 1500) -> str:
    """Inject relevant engrams and return a formatted context string."""
    try:
        result = bridge.inject(task, budget=budget)
        if not isinstance(result, dict):
            raise ValueError("Invalid recall response")
        sections = [result.get(key, "") for key in ("directives", "constraints", "consider")]
        if any(s is not None and not isinstance(s, str) for s in sections):
            raise ValueError("Invalid recall section")
    except Exception:
        raise PlurMemoryError("PLUR memory recall failed; context is unavailable") from None
    return "\n".join(s for s in sections if s and s.strip())
