"""
Thin bridge to the PLUR CLI binary.

Finds `plur` on PATH, caches the location, and wraps all calls
with --json output, timeout handling, and error parsing.
"""

import json
import logging
import os
import shutil
import subprocess
import time
from collections import OrderedDict
from typing import Any

logger = logging.getLogger("plur_hermes.bridge")

_NPX_CLI_VERSION = "0.9.4"

_DEFAULT_DEDUP_CACHE_SIZE = 256
_DEFAULT_TIMEOUT = 30
_DEFAULT_INJECT_TIMEOUT = 5
_DEFAULT_RETRIES = 3
_RETRY_DELAYS = (5, 15, 30)

_SAFE_RESPONSE: dict = {"results": [], "count": 0, "injected_ids": []}

_NOT_FOUND_MSG = (
    f"PLUR CLI not found. Install: npm install -g @plur-ai/cli@{_NPX_CLI_VERSION}"
)


class PlurBridgeError(Exception):
    """Raised when CLI call fails."""
    pass


class PlurNotFoundError(PlurBridgeError):
    """Raised when plur CLI binary cannot be found."""
    pass


class PlurBridge:
    """Manages subprocess calls to the plur CLI."""

    def __init__(self, plur_path: str | None = None,
                 dedup_cache_size: int = _DEFAULT_DEDUP_CACHE_SIZE):
        self._binary: str | None = None
        self._plur_path = plur_path or os.environ.get("PLUR_PATH")
        self._dedup_cache_size = max(0, dedup_cache_size)
        self._dedup_cache: "OrderedDict[str, dict]" = OrderedDict()
        self._timeout = int(os.environ.get("PLUR_BRIDGE_TIMEOUT", str(_DEFAULT_TIMEOUT)))
        self._inject_timeout = int(os.environ.get("PLUR_BRIDGE_INJECT_TIMEOUT", str(_DEFAULT_INJECT_TIMEOUT)))
        self._retry_enabled = os.environ.get("PLUR_BRIDGE_RETRY", "true").lower() != "false"

    def _cache_get(self, normalized: str) -> dict | None:
        if self._dedup_cache_size == 0 or not normalized:
            return None
        if normalized not in self._dedup_cache:
            return None
        self._dedup_cache.move_to_end(normalized)
        return self._dedup_cache[normalized]

    def _cache_put(self, normalized: str, value: dict) -> None:
        if self._dedup_cache_size == 0 or not normalized:
            return
        if normalized in self._dedup_cache:
            self._dedup_cache.move_to_end(normalized)
            self._dedup_cache[normalized] = value
            return
        self._dedup_cache[normalized] = value
        while len(self._dedup_cache) > self._dedup_cache_size:
            self._dedup_cache.popitem(last=False)

    def _find_binary(self) -> str:
        if self._binary:
            return self._binary

        found = shutil.which("plur")
        if found:
            self._binary = found
            return found

        for path in [
            os.path.expanduser("~/.bun/bin/plur"),
            "/usr/local/bin/plur",
            os.path.expanduser("~/.npm-global/bin/plur"),
        ]:
            if os.path.isfile(path) and os.access(path, os.X_OK):
                self._binary = path
                return path

        npx = shutil.which("npx")
        if npx:
            self._binary = f"npx:@plur-ai/cli@{_NPX_CLI_VERSION}"
            return self._binary

        raise PlurNotFoundError(_NOT_FOUND_MSG)

    def call(self, command: str, args: list[str] | None = None,
             timeout: int | None = None, retries: int = _DEFAULT_RETRIES) -> dict[str, Any]:
        binary = self._find_binary()
        args = args or []
        effective_timeout = timeout if timeout is not None else self._timeout
        effective_retries = retries if self._retry_enabled else 0

        if binary.startswith("npx:"):
            package = binary.split(":", 1)[1]
            cmd = ["npx", "-y", package, command, "--json"] + args
        else:
            cmd = [binary, command, "--json"] + args

        if self._plur_path:
            cmd.extend(["--path", self._plur_path])

        for attempt in range(effective_retries + 1):
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=effective_timeout)
            except subprocess.TimeoutExpired:
                if attempt < effective_retries:
                    delay = _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)]
                    logger.warning("PLUR CLI timed out (attempt %d/%d): plur %s — retrying in %ds",
                                   attempt + 1, effective_retries + 1, command, delay)
                    time.sleep(delay)
                    continue
                logger.warning("PLUR CLI timed out after %d attempt(s): plur %s — returning safe fallback",
                               effective_retries + 1, command)
                return _SAFE_RESPONSE.copy()
            except FileNotFoundError:
                raise PlurNotFoundError(_NOT_FOUND_MSG)

            if result.returncode == 2:
                return json.loads(result.stdout) if result.stdout.strip() else {"results": [], "count": 0}

            if result.returncode != 0:
                raise PlurBridgeError(
                    f"CLI error (exit {result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
                )

            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError:
                raise PlurBridgeError(f"Invalid JSON from CLI: {result.stdout[:200]}")

        return _SAFE_RESPONSE.copy()  # unreachable; satisfies type checker

    def learn(self, statement: str, scope: str = "global", type: str = "behavioral",
              domain: str | None = None, source: str | None = None,
              tags: list[str] | None = None, rationale: str | None = None,
              visibility: str | None = None,
              knowledge_anchors: list[dict] | None = None,
              dual_coding: dict | None = None,
              abstract: str | None = None,
              derived_from: str | None = None,
              force: bool = False) -> dict:
        needle = statement.strip().casefold()

        if not force:
            cached = self._cache_get(needle)
            if cached is not None:
                return {**cached, "deduplicated": True}
            existing = self._find_duplicate(statement)
            if existing is not None:
                self._cache_put(needle, existing)
                return {**existing, "deduplicated": True}

        args = [statement, "--scope", scope, "--type", type]
        if domain:
            args.extend(["--domain", domain])
        if source:
            args.extend(["--source", source])
        if tags:
            args.extend(["--tags", ",".join(tags)])
        if rationale:
            args.extend(["--rationale", rationale])
        if visibility:
            args.extend(["--visibility", visibility])
        if knowledge_anchors:
            args.extend(["--knowledge-anchors", json.dumps(knowledge_anchors)])
        if dual_coding:
            args.extend(["--dual-coding", json.dumps(dual_coding)])
        if abstract:
            args.extend(["--abstract", abstract])
        if derived_from:
            args.extend(["--derived-from", derived_from])
        result = self.call("learn", args)
        if result.get("id"):
            self._cache_put(needle, {
                "id": result["id"],
                "statement": result.get("statement", statement),
            })
        return result

    def _find_duplicate(self, statement: str) -> dict | None:
        """Return existing engram if statement matches verbatim, else None.

        Falls through silently on any recall failure so learn() never blocks
        on a bridge issue.
        """
        needle = statement.strip().casefold()
        if not needle:
            return None
        try:
            response = self.recall(statement, limit=3, fast=True)
        except Exception:
            return None
        for engram in response.get("results", []) or []:
            existing_statement = (engram.get("statement") or "").strip().casefold()
            if existing_statement and existing_statement == needle:
                return {"id": engram.get("id"), "statement": engram.get("statement")}
        return None

    def recall(self, query: str, limit: int = 10, fast: bool = False) -> dict:
        args = [query, "--limit", str(limit)]
        if fast:
            args.append("--fast")
        return self.call("recall", args)

    def inject(self, task: str, budget: int = 2000, fast: bool = True) -> dict:
        args = [task, "--budget", str(budget)]
        if fast:
            args.append("--fast")
        # Short timeout, no retries — inject runs on the pre-LLM blocking path.
        return self.call("inject", args, timeout=self._inject_timeout, retries=0)

    def list_engrams(self, domain: str | None = None, type: str | None = None,
                     scope: str | None = None, limit: int | None = None,
                     meta: bool = False) -> dict:
        args: list[str] = []
        if domain: args.extend(["--domain", domain])
        if type: args.extend(["--type", type])
        if scope: args.extend(["--scope", scope])
        if limit is not None: args.extend(["--limit", str(limit)])
        if meta: args.append("--meta")
        return self.call("list", args)

    def forget(self, id: str | None = None, reason: str | None = None,
               search: str | None = None) -> dict:
        if not id and not search:
            raise PlurBridgeError("forget() requires either id or search parameter")
        args: list[str] = []
        if id:
            args.append(id)
        if search:
            args.extend(["--search", search])
        if reason:
            args.extend(["--reason", reason])
        return self.call("forget", args)

    def feedback(self, id: str | None = None, signal: str | None = None,
                 batch: list[tuple[str, str]] | None = None) -> dict:
        if batch:
            args = ["--batch", json.dumps([{"id": eid, "signal": sig} for eid, sig in batch])]
            return self.call("feedback", args)
        if not id or not signal:
            raise PlurBridgeError("feedback() requires id and signal, or batch parameter")
        return self.call("feedback", [id, signal])

    def promote(self, id: str) -> dict:
        return self.call("promote", [id])

    def stores_add(self, path: str, scope: str = "global",
                   shared: bool = False, readonly: bool = False) -> dict:
        args = [path, "--scope", scope]
        if shared:
            args.append("--shared")
        if readonly:
            args.append("--readonly")
        return self.call("stores", ["add"] + args)

    def stores_list(self) -> dict:
        return self.call("stores", ["list"])

    def ingest(self, content: str, source: str | None = None, extract_only: bool = False,
               scope: str | None = None, domain: str | None = None) -> dict:
        args = [content]
        if source:
            args.extend(["--source", source])
        if scope:
            args.extend(["--scope", scope])
        if domain:
            args.extend(["--domain", domain])
        if extract_only:
            args.append("--extract-only")
        return self.call("ingest", args)

    def capture(self, summary: str, agent: str = "hermes", session: str | None = None) -> dict:
        args = [summary, "--agent", agent]
        if session: args.extend(["--session", session])
        return self.call("capture", args)

    def timeline(self, query: str | None = None, limit: int = 20) -> dict:
        args = ["--limit", str(limit)]
        if query: args.insert(0, query)
        return self.call("timeline", args)

    def status(self) -> dict:
        return self.call("status")

    def sync(self) -> dict:
        return self.call("sync")

    def packs_list(self) -> dict:
        return self.call("packs", ["list"])

    def similarity_search(self, query: str, limit: int = 10, scope: str | None = None) -> dict:
        args = [query, "--limit", str(limit)]
        if scope:
            args.extend(["--scope", scope])
        return self.call("similarity-search", args)

    def batch_decay(self, context_scope: str | None = None) -> dict:
        args: list[str] = []
        if context_scope:
            args.extend(["--context-scope", context_scope])
        return self.call("batch-decay", args)

    def packs_install(self, source: str) -> dict:
        return self.call("packs", ["install", source])
