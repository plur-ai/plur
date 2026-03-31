"""
Thin bridge to the PLUR CLI binary.

Finds `plur` on PATH, caches the location, and wraps all calls
with --json output, timeout handling, and error parsing.
"""

import json
import os
import shutil
import subprocess
from typing import Any

_NPX_CLI_VERSION = "0.1.0"


class PlurBridgeError(Exception):
    """Raised when CLI call fails."""
    pass


class PlurNotFoundError(PlurBridgeError):
    """Raised when plur CLI binary cannot be found."""
    pass


class PlurBridge:
    """Manages subprocess calls to the plur CLI."""

    def __init__(self, plur_path: str | None = None):
        self._binary: str | None = None
        self._plur_path = plur_path or os.environ.get("PLUR_PATH")

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

        raise PlurNotFoundError(
            "PLUR CLI not found. Install: npm install -g @plur-ai/cli"
        )

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

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise PlurBridgeError(f"CLI timed out after {timeout}s: plur {command}")
        except FileNotFoundError:
            raise PlurNotFoundError("PLUR CLI not found. Install: npm install -g @plur-ai/cli")

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

    def learn(self, statement: str, scope: str = "global", type: str = "behavioral",
              domain: str | None = None, source: str | None = None,
              tags: list[str] | None = None, rationale: str | None = None,
              visibility: str | None = None,
              knowledge_anchors: list[dict] | None = None,
              dual_coding: dict | None = None,
              abstract: str | None = None,
              derived_from: str | None = None) -> dict:
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
        return self.call("learn", args)

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

    def packs_install(self, source: str) -> dict:
        return self.call("packs", ["install", source])
