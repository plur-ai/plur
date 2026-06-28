"""Pythonic client for PLUR memory."""
from __future__ import annotations

from typing import Any, Iterable

from .bridge import run_json


class Plur:
    """A small, Pythonic interface to a local PLUR store.

    Every call shells out to the `@plur-ai/cli` (see :mod:`plur_ai.bridge` for
    resolution). PLUR keeps memory as plain YAML on disk; search is local and
    zero-cost.

    Args:
        path: storage directory (sets ``PLUR_PATH``). Defaults to ``~/.plur``.
        binary: explicit path to the `plur` executable. Otherwise resolved from
            ``PLUR_CLI``, ``PATH``, or an ``npx @plur-ai/cli`` fallback.
        timeout: default per-call timeout in seconds.
    """

    def __init__(
        self,
        path: str | None = None,
        binary: str | None = None,
        timeout: float = 30,
    ) -> None:
        self.path = path
        self.binary = binary
        self.timeout = timeout

    def _run(self, args: list[str], *, timeout: float | None = None) -> Any:
        return run_json(
            args, binary=self.binary, path=self.path,
            timeout=self.timeout if timeout is None else timeout,
        )

    def learn(
        self,
        statement: str,
        *,
        type: str | None = None,
        scope: str | None = None,
        domain: str | None = None,
        tags: Iterable[str] | None = None,
        source: str | None = None,
        rationale: str | None = None,
    ) -> dict:
        """Store a correction, preference, or convention. Returns the engram."""
        args = ["learn", statement]
        if type:
            args += ["--type", type]
        if scope:
            args += ["--scope", scope]
        if domain:
            args += ["--domain", domain]
        if source:
            args += ["--source", source]
        if rationale:
            args += ["--rationale", rationale]
        if tags:
            args += ["--tags", ",".join(tags)]
        return self._run(args) or {}

    def recall(self, query: str, *, limit: int | None = None) -> list[dict]:
        """Search engrams. Returns the list of matching engrams (most relevant first)."""
        args = ["recall", query]
        if limit is not None:
            args += ["--limit", str(limit)]
        res = self._run(args) or {}
        return res.get("results", [])

    def inject(self, task: str, *, budget: int | None = None) -> dict:
        """Select engrams relevant to a task within a token budget.

        Returns a dict with ``directives``/``constraints``/``consider`` strings
        plus ``count`` and ``tokens_used`` — the same payload the MCP server's
        ``plur_inject`` tool returns.
        """
        args = ["inject", task]
        if budget is not None:
            args += ["--budget", str(budget)]
        return self._run(args, timeout=min(self.timeout, 15)) or {}

    def status(self) -> dict:
        """System health — engram/episode/pack counts and storage path."""
        return self._run(["status"]) or {}
