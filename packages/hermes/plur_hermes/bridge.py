"""
Thin bridge to the PLUR CLI binary.

Finds `plur` on PATH, caches the location, and wraps all calls
with --json output, timeout handling, and error parsing.
"""

import json
import logging
import os
import random
import re
import shutil
import subprocess
import time
from collections import OrderedDict
from typing import Any

logger = logging.getLogger(__name__)

_NPX_CLI_VERSION = "0.9.4"

_DEFAULT_DEDUP_CACHE_SIZE = 256

_NOT_FOUND_MSG = (
    f"PLUR CLI not found. Install: npm install -g @plur-ai/cli@{_NPX_CLI_VERSION}"
)

# Lock-failure retry config.
#
# The CLI itself retries the O_EXCL lock 5× (100/200/400/800/1600ms = ~3.1s)
# before throwing. We add 3 outer retries on top — each retry spawns a fresh
# CLI subprocess that gets its own 3.1s budget. With jitter, worst-case wall
# time is ~20s for the full retry chain (4 × ~3.1s CLI + ~7s bridge sleeps).
# This covers bursty cron-driven contention but does NOT save you if the
# holder takes >5s to release; that needs a core-side retry-budget bump.
#
# Marker patterns must stay in sync with messages thrown by `withLock`
# (packages/core/src/sync.ts) and `withAsyncLock` (packages/core/src/store/
# async-lock.ts). Patterns are permissive — match any "acquire ... lock"
# phrasing so minor wording changes upstream don't silently disable retry.
_LOCK_FAILURE_PATTERNS = (
    re.compile(r"[Ff]ailed to acquire lock"),
    re.compile(r"[Cc]ould not acquire .*lock"),
    re.compile(r"[Ll]ock acquisition (?:failed|timed out)"),
)
_LOCK_RETRY_DELAYS = (1.0, 2.0, 4.0)  # base seconds; 3 retries, exp backoff
_LOCK_JITTER_FRACTION = 0.5  # ±50% jitter; defeats thundering-herd phase-lock


def _is_lock_failure(text: str) -> bool:
    """Detect lock-acquisition failures across known CLI phrasings."""
    return any(p.search(text) for p in _LOCK_FAILURE_PATTERNS)


def _jittered_delay(base: float) -> float:
    """Compute a backoff delay with ±_LOCK_JITTER_FRACTION randomization.

    Without jitter, two concurrent bridge instances that fail at the same
    instant retry in lockstep forever (deterministic exp backoff). Jitter
    breaks the phase lock so one writer can complete while the other waits.
    """
    fuzz = base * _LOCK_JITTER_FRACTION
    return base + random.uniform(-fuzz, fuzz)


def _extract_cli_error_message(stderr: str, stdout: str) -> str:
    """Pull a clean error message from CLI output.

    The bridge always passes --json, so the CLI's error path emits
    `{"error": "..."}` on stdout via outputJson(). Try the structured stdout
    first; fall back to stderr only if stdout has no usable structured error.
    This ordering matters: npm/Node.js routinely write deprecation warnings
    to stderr, which would otherwise hide the real CLI error.
    """
    stdout_text = (stdout or "").strip()
    stderr_text = (stderr or "").strip()

    # Prefer the structured stdout error (the --json contract).
    # If the CLI emitted {"error": ...} at all — even with a null/empty value
    # — that's the authoritative signal from the --json path; prefer it over
    # stderr noise (npm warnings, deprecations, etc).
    if stdout_text.startswith("{"):
        try:
            parsed = json.loads(stdout_text)
            if isinstance(parsed, dict) and "error" in parsed:
                err_val = parsed["error"]
                if err_val is None:
                    return ""
                return str(err_val)
        except json.JSONDecodeError:
            pass  # malformed JSON — fall through to raw stdout

    # No structured error. Use stderr if it has content (real Node errors,
    # not just npm warnings: callers can grep stderr_text for noise patterns
    # if needed, but for now we just trust whatever's there over stdout junk).
    if stderr_text:
        return stderr_text

    # Last resort — raw stdout, even if it's an unrecognized JSON shape.
    return stdout_text


class PlurBridgeError(Exception):
    """Raised when CLI call fails."""
    pass


class PlurNotFoundError(PlurBridgeError):
    """Raised when plur CLI binary cannot be found."""
    pass


class PlurLockError(PlurBridgeError):
    """Raised when the CLI cannot acquire the engram-store write lock.

    Lock failures are usually transient — another writer is holding the
    O_EXCL .lock file. The bridge already retries; callers seeing this
    error have exhausted those retries and the contention is sustained.
    """
    pass


class PlurBridge:
    """Manages subprocess calls to the plur CLI."""

    def __init__(self, plur_path: str | None = None,
                 dedup_cache_size: int = _DEFAULT_DEDUP_CACHE_SIZE):
        self._binary: str | None = None
        self._plur_path = plur_path or os.environ.get("PLUR_PATH")
        self._dedup_cache_size = max(0, dedup_cache_size)
        self._dedup_cache: "OrderedDict[str, dict]" = OrderedDict()

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

    def call(self, command: str, args: list[str] | None = None, timeout: int = 30) -> dict[str, Any]:
        binary = self._find_binary()
        args = args or []

        if binary.startswith("npx:"):
            package = binary.split(":", 1)[1]
            cmd = ["npx", "-y", package, command, "--json"] + args
        else:
            cmd = [binary, command, "--json"] + args

        if self._plur_path:
            cmd.extend(["--path", self._plur_path])

        # First attempt — no delay, no log.
        try:
            return self._invoke_cli(cmd, command, timeout)
        except PlurLockError as e:
            last_lock_error: PlurLockError = e

        # Retries — only entered on lock failure. Each retry uses jittered
        # exp backoff to avoid phase-locking with concurrent bridge instances.
        for attempt, base_delay in enumerate(_LOCK_RETRY_DELAYS, start=1):
            delay = _jittered_delay(base_delay)
            logger.warning(
                "plur %s: lock contended, retrying in %.1fs (retry %d/%d)",
                command, delay, attempt, len(_LOCK_RETRY_DELAYS),
            )
            time.sleep(delay)
            try:
                result = self._invoke_cli(cmd, command, timeout)
                logger.info("plur %s: succeeded on retry #%d", command, attempt)
                return result
            except PlurLockError as e:
                last_lock_error = e

        # All retries exhausted. last_lock_error is guaranteed set by the
        # initial attempt above; this raise is not behind an assert so it
        # remains valid under `python -O`.
        raise last_lock_error

    def _invoke_cli(self, cmd: list[str], command: str, timeout: int) -> dict[str, Any]:
        """Single CLI invocation. Raises PlurLockError on lock contention so
        the caller can retry; other failures raise PlurBridgeError directly."""
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise PlurBridgeError(f"CLI timed out after {timeout}s: plur {command}")
        except FileNotFoundError:
            raise PlurNotFoundError(_NOT_FOUND_MSG)

        if result.returncode == 2:
            return json.loads(result.stdout) if result.stdout.strip() else {"results": [], "count": 0}

        if result.returncode != 0:
            error_text = (result.stderr or "") + (result.stdout or "")
            clean_msg = _extract_cli_error_message(result.stderr, result.stdout)
            if _is_lock_failure(error_text):
                raise PlurLockError(
                    f"CLI could not acquire engram-store lock (plur {command}): {clean_msg}"
                )
            raise PlurBridgeError(
                f"CLI error (exit {result.returncode}): {clean_msg}"
            )

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            raise PlurBridgeError(f"Invalid JSON from CLI: {result.stdout[:200]}")

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
        return self.call("inject", args)

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
