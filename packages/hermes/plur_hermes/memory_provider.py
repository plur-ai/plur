"""PlurMemoryProvider — MemoryProvider ABC adapter for plur-hermes.

Bridges the Hermes MemoryProvider lifecycle to the PLUR CLI via PlurBridge.
This adapter allows PLUR to be activated as a proper Hermes memory provider
(``memory.provider: plur`` in config.yaml) rather than only as a standalone
plugin in the ``hermes_agent.plugins`` entry-point group.

Both paths are mutually compatible and may run in the same process:
- Standalone path (hermes_agent.plugins): registers hooks + tools via
  ``ctx.register_hook()`` / ``ctx.register_tool()``.  Always active when
  plur-hermes is installed.
- MemoryProvider path (hermes_agent.memory_providers): exposes PLUR through
  the official MemoryProvider ABC so it appears in ``hermes plugins --memory``
  and can be selected via ``memory.provider: plur`` in config.yaml.

The two paths share a single ``PlurBridge`` instance when both are active,
so CLI subprocess spawns are deduplicated across both lifecycle paths.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

from .bridge import PlurBridge, PlurBridgeError, PlurNotFoundError
from .learner import extract_learning_patterns

logger = logging.getLogger("plur_hermes.memory_provider")

# Tool schemas re-exported for the MemoryProvider path.  The standalone path
# registers these via ctx.register_tool(); the MemoryProvider path exposes
# them via get_tool_schemas() so MemoryManager can inject them into the
# agent's tool surface.  The schema list is factored out here so both paths
# share a single source of truth without cross-importing __init__.py.
_PLUR_TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "plur_learn",
        "description": "Create a new engram — store a correction, preference, pattern, or decision",
        "parameters": {
            "type": "object",
            "properties": {
                "statement": {"type": "string", "description": "The knowledge assertion"},
                "scope": {"type": "string", "default": "global"},
                "type": {
                    "type": "string",
                    "enum": ["behavioral", "terminological", "procedural", "architectural"],
                    "default": "behavioral",
                },
                "domain": {"type": "string"},
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Classification tags",
                },
                "rationale": {"type": "string", "description": "Why this knowledge matters"},
                "visibility": {
                    "type": "string",
                    "enum": ["private", "public", "template"],
                    "default": "private",
                },
                "knowledge_anchors": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "relevance": {"type": "number"},
                            "snippet": {"type": "string"},
                        },
                    },
                    "description": "Related file references",
                },
                "dual_coding": {
                    "type": "object",
                    "properties": {
                        "example": {"type": "string"},
                        "analogy": {"type": "string"},
                    },
                    "description": "Concrete example and analogy",
                },
                "abstract": {"type": "string", "description": "One-line abstract"},
                "derived_from": {
                    "type": "string",
                    "description": "Source engram ID this was derived from",
                },
                "force": {
                    "type": "boolean",
                    "default": False,
                    "description": "Skip duplicate detection and always create a new engram",
                },
            },
            "required": ["statement"],
        },
    },
    {
        "name": "plur_recall",
        "description": "Search engrams by topic",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 10},
                "fast": {"type": "boolean", "default": False},
            },
            "required": ["query"],
        },
    },
    {
        "name": "plur_inject",
        "description": "Get relevant engrams for a task (three-tier output)",
        "parameters": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "budget": {"type": "integer", "default": 2000},
                "fast": {"type": "boolean", "default": False},
            },
            "required": ["task"],
        },
    },
    {
        "name": "plur_list",
        "description": "List all engrams with optional filtering",
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "type": {"type": "string"},
                "scope": {"type": "string"},
                "limit": {"type": "integer"},
                "meta": {"type": "boolean", "default": False},
            },
        },
    },
    {
        "name": "plur_forget",
        "description": "Retire an engram by ID or search query",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "search": {
                    "type": "string",
                    "description": "Forget engrams matching this search query",
                },
                "reason": {"type": "string"},
            },
        },
    },
    {
        "name": "plur_feedback",
        "description": "Rate an engram (positive|negative|neutral) — supports single or batch mode",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "signal": {
                    "type": "string",
                    "enum": ["positive", "negative", "neutral"],
                },
                "batch": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "signal": {"type": "string"},
                        },
                    },
                    "description": "Batch feedback: list of {id, signal} pairs",
                },
            },
        },
    },
    {
        "name": "plur_capture",
        "description": "Record an episode to the timeline",
        "parameters": {
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
        },
    },
    {
        "name": "plur_timeline",
        "description": "Query the episodic timeline",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 20},
            },
        },
    },
    {
        "name": "plur_status",
        "description": "Check PLUR system health",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "plur_sync",
        "description": "Cross-device sync via git",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "plur_packs_list",
        "description": "List installed engram packs",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "plur_packs_install",
        "description": "Install an engram pack",
        "parameters": {
            "type": "object",
            "properties": {"source": {"type": "string"}},
            "required": ["source"],
        },
    },
    {
        "name": "plur_ingest",
        "description": "Extract and save engrams from content (text, logs, conversations)",
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Text content to extract engrams from",
                },
                "source": {"type": "string", "description": "Source identifier"},
                "extract_only": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, extract but don't save",
                },
                "scope": {"type": "string"},
                "domain": {"type": "string"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "plur_packs_export",
        "description": "Export engrams as a shareable pack",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "domain": {"type": "string"},
                "scope": {"type": "string"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "plur_promote",
        "description": "Promote an engram — increase its activation and priority",
        "parameters": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
    {
        "name": "plur_stores_add",
        "description": "Add a knowledge store path",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "scope": {"type": "string", "default": "global"},
                "shared": {"type": "boolean", "default": False},
                "readonly": {"type": "boolean", "default": False},
            },
            "required": ["path"],
        },
    },
    {
        "name": "plur_stores_list",
        "description": "List configured knowledge stores",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "plur_similarity_search",
        "description": (
            "Search engrams by cosine similarity, returning scores. "
            "Scores > 0.9 indicate duplicates, 0.7-0.9 related, < 0.7 new."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "default": 10},
                "scope": {"type": "string"},
            },
            "required": ["query"],
        },
    },
]

# Correction markers for heuristic feedback signal detection (mirrors __init__.py).
_CORRECTION_MARKERS = (
    "actually,", "actually ", "no,", "wrong,", "incorrect,",
    "that's wrong", "not correct", "that is wrong",
)
_FEEDBACK_MIN_CONFIDENCE = 0.6


def _detect_injection_signal(engram_text: str, response: str) -> tuple[str | None, float]:
    """Re-exported from __init__.py for symmetric signal detection on the MemoryProvider path."""
    response_lower = response.lower()
    engram_lower = engram_text.lower().strip()
    if not engram_lower:
        return None, 0.0
    if engram_lower in response_lower:
        return "positive", 0.95
    words = engram_lower.split()
    tris: set[str] = set()
    if len(words) >= 3:
        tris = {" ".join(words[i:i + 3]) for i in range(len(words) - 2)}
    elif words:
        tris = set(words)
    if tris:
        resp_words = response_lower.split()
        resp_tris: set[str] = set()
        if len(resp_words) >= 3:
            resp_tris = {" ".join(resp_words[i:i + 3]) for i in range(len(resp_words) - 2)}
        elif resp_words:
            resp_tris = set(resp_words)
        if resp_tris:
            overlap = len(tris & resp_tris) / len(tris)
            if overlap >= 0.8:
                return "positive", 0.7 + 0.3 * overlap
    engram_words = {w for w in engram_lower.split() if len(w) > 4}
    if engram_words:
        for marker in _CORRECTION_MARKERS:
            idx = response_lower.find(marker)
            while idx != -1:
                window = response_lower[max(0, idx - 100):idx + 200]
                if any(w in window for w in engram_words):
                    return "negative", 0.65
                idx = response_lower.find(marker, idx + 1)
    return None, 0.0


class PlurMemoryProvider:
    """Hermes MemoryProvider ABC adapter for PLUR persistent memory.

    Implements the MemoryProvider ABC so PLUR can be selected as a first-class
    Hermes memory provider via ``memory.provider: plur`` in config.yaml. The
    provider exposes the same PLUR tools as the standalone hook path and adds
    MemoryProvider-specific lifecycle integrations:

    - ``prefetch()``      — inject engrams relevant to the upcoming user turn
    - ``sync_turn()``     — auto-learn from completed turns (mirrors post_llm_call)
    - ``on_session_end()``— capture session episode at the real session boundary
    - ``system_prompt_block()`` — static PLUR status text in the system prompt

    When both this provider and the standalone plugin path are active in the same
    process (which is the default when plur-hermes is installed), they share a
    single ``PlurBridge`` instance via the ``bridge`` parameter so CLI subprocess
    spawns are deduplicated.
    """

    def __init__(self, bridge: Optional[PlurBridge] = None) -> None:
        # Accept an injected bridge so the standalone plugin path can share
        # its bridge instance.  Fall back to creating a fresh one if called
        # directly (e.g. when loaded via hermes_agent.memory_providers entry
        # point without the standalone plugin also being active).
        self._bridge: Optional[PlurBridge] = bridge
        self._available: Optional[bool] = None  # cached; None = not yet checked
        self._session_id: str = ""
        self._platform: str = "unknown"
        self._agent_context: str = "primary"
        self._injected_engrams: list[dict] = []   # cleared after feedback flush
        self._injected_lock = threading.Lock()
        self._learn_count: int = 0

    # -- Lazy bridge construction --------------------------------------------

    def _get_bridge(self) -> PlurBridge:
        if self._bridge is None:
            self._bridge = PlurBridge()
        return self._bridge

    # -- MemoryProvider ABC --------------------------------------------------

    @property
    def name(self) -> str:
        return "plur"

    def is_available(self) -> bool:
        """Return True if the PLUR CLI is reachable.

        Results are cached after the first check so repeated calls during
        Hermes startup (discover + load) don't spawn multiple CLI subprocesses.
        """
        if self._available is not None:
            return self._available
        try:
            bridge = self._get_bridge()
            bridge.status()
            self._available = True
        except (PlurNotFoundError, PlurBridgeError, Exception):
            self._available = False
        return self._available

    def initialize(self, session_id: str, **kwargs) -> None:
        """Initialize provider for a Hermes session.

        Verifies CLI availability and logs engram count.  Extracts
        ``hermes_home``, ``platform``, and ``agent_context`` from kwargs.
        """
        self._session_id = session_id
        self._platform = kwargs.get("platform", "unknown")
        self._agent_context = kwargs.get("agent_context", "primary")
        self._learn_count = 0
        self._injected_engrams = []
        try:
            bridge = self._get_bridge()
            status = bridge.status()
            logger.info(
                "PLUR MemoryProvider initialized: session=%s platform=%s "
                "engrams=%s context=%s",
                session_id, self._platform,
                status.get("engram_count", "?"),
                self._agent_context,
            )
        except Exception as e:
            logger.warning("PLUR MemoryProvider initialize: status check failed: %s", e)

    def system_prompt_block(self) -> str:
        """Return a brief static PLUR context block for the system prompt.

        Intentionally terse — detailed recalled context is injected per-turn
        via ``prefetch()``.  Returns empty string on any bridge failure so a
        broken PLUR install never corrupts the system prompt.
        """
        try:
            bridge = self._get_bridge()
            status = bridge.status()
            count = status.get("engram_count")
            if count is None:
                return ""
            return (
                f"PLUR persistent memory is active with {count} engrams. "
                "Use plur_recall to search memory and plur_learn to store new knowledge."
            )
        except Exception:
            return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Inject engrams relevant to ``query`` before the LLM call.

        Uses the fast inject path (BM25 only) to stay under the tight
        per-turn deadline.  Switch to hybrid via ``PLUR_INJECT_MODE=hybrid``.
        Stores injected engram metadata so ``sync_turn`` can send feedback
        after the turn.

        Returns formatted text for Hermes to include as context, or empty
        string if nothing relevant or on any bridge failure.
        """
        if not query:
            return ""
        try:
            bridge = self._get_bridge()
            mode = os.environ.get("PLUR_INJECT_MODE", "fast")
            fast = mode != "hybrid"
            result = bridge.inject(query, fast=fast)
            if result.get("count", 0) == 0:
                return ""

            # Cache injected engrams for post-turn feedback.
            new_engrams = [
                {"id": e.get("id"), "statement": e.get("statement", "")}
                for e in result.get("results", [])
                if e.get("id") and e.get("statement")
            ]
            with self._injected_lock:
                self._injected_engrams.extend(new_engrams)

            # Build the context block.
            lines = []
            if result.get("directives"):
                lines.append(result["directives"])
            if result.get("constraints"):
                lines.append(result["constraints"])
            if result.get("consider"):
                lines.append(result["consider"])
            return "\n".join(lines) if lines else ""
        except Exception as e:
            logger.debug("PLUR prefetch failed (non-fatal): %s", e)
            return ""

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Auto-learn from the completed turn and send injection feedback.

        Mirrors the ``post_llm_call`` hook behaviour:
        1. Extract self-reported learnings from the assistant response.
        2. Send positive/negative feedback signals for injected engrams that
           appeared or were contradicted in the response.

        Only writes in the ``primary`` agent context — skipping cron and
        subagent contexts matches the standalone hook path's behaviour (no
        writes for contexts where the user representation would be corrupted).
        """
        if self._agent_context != "primary":
            return

        response = assistant_content or ""
        bridge = self._get_bridge()

        # 1. Auto-learn from self-reported patterns.
        try:
            learnings = extract_learning_patterns(response)
            for statement in learnings:
                bridge.learn(
                    statement,
                    source="hermes:auto",
                    rationale="Auto-extracted from assistant self-report",
                )
                self._learn_count += 1
        except Exception as e:
            logger.debug("PLUR sync_turn: learning extraction failed: %s", e)

        # 2. Injection feedback.
        if os.environ.get("PLUR_INJECTION_FEEDBACK", "true").lower() == "false":
            return
        try:
            with self._injected_lock:
                snapshot = list(self._injected_engrams)
                self._injected_engrams = []

            if not snapshot or not response:
                return

            feedback_batch: list[tuple[str, str]] = []
            for engram in snapshot:
                eid = engram.get("id")
                text = engram.get("statement", "")
                if not eid or not text:
                    continue
                signal, confidence = _detect_injection_signal(text, response)
                if signal and confidence >= _FEEDBACK_MIN_CONFIDENCE:
                    feedback_batch.append((eid, signal))
            if feedback_batch:
                bridge.feedback(batch=feedback_batch)
        except Exception as e:
            logger.debug("PLUR sync_turn: injection feedback failed: %s", e)

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Capture a session episode when the session actually ends.

        This fires at real session boundaries (``/reset``, ``/new``, CLI exit,
        gateway session expiry) — NOT after every turn.  Mirrors the
        ``on_session_end`` hook's capture call so both paths record the same
        episode regardless of which is active.
        """
        try:
            bridge = self._get_bridge()
            parts = [f"Hermes session {self._session_id}"]
            if self._learn_count:
                parts.append(f"— {self._learn_count} learnings captured")
            parts.append(f"[{self._platform}]")
            bridge.capture(" ".join(parts), agent="hermes", session=self._session_id)
        except Exception as e:
            logger.debug("PLUR on_session_end: capture failed: %s", e)
        finally:
            self._session_id = ""
            self._learn_count = 0

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return the PLUR tool schemas for MemoryManager injection."""
        return list(_PLUR_TOOL_SCHEMAS)

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        """Dispatch a PLUR tool call from the MemoryManager routing layer."""
        try:
            bridge = self._get_bridge()
            result = self._dispatch(bridge, tool_name, args)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _dispatch(self, bridge: PlurBridge, tool_name: str, args: Dict[str, Any]) -> Any:
        """Route ``tool_name`` to the correct PlurBridge method."""
        if tool_name == "plur_learn":
            return bridge.learn(
                args["statement"],
                scope=args.get("scope", "global"),
                type=args.get("type", "behavioral"),
                domain=args.get("domain"),
                tags=args.get("tags"),
                rationale=args.get("rationale"),
                visibility=args.get("visibility"),
                knowledge_anchors=args.get("knowledge_anchors"),
                dual_coding=args.get("dual_coding"),
                abstract=args.get("abstract"),
                derived_from=args.get("derived_from"),
                force=args.get("force", False),
            )
        if tool_name == "plur_recall":
            return bridge.recall(
                args["query"],
                limit=args.get("limit", 10),
                fast=args.get("fast", False),
            )
        if tool_name == "plur_inject":
            return bridge.inject(
                args["task"],
                budget=args.get("budget", 2000),
                fast=args.get("fast", False),
            )
        if tool_name == "plur_list":
            return bridge.list_engrams(
                domain=args.get("domain"),
                type=args.get("type"),
                scope=args.get("scope"),
                limit=args.get("limit"),
                meta=args.get("meta", False),
            )
        if tool_name == "plur_forget":
            return bridge.forget(
                id=args.get("id"),
                reason=args.get("reason"),
                search=args.get("search"),
            )
        if tool_name == "plur_feedback":
            batch = args.get("batch")
            if batch:
                return bridge.feedback(
                    batch=[(item["id"], item["signal"]) for item in batch]
                )
            return bridge.feedback(args["id"], args["signal"])
        if tool_name == "plur_capture":
            return bridge.capture(args["summary"])
        if tool_name == "plur_timeline":
            return bridge.timeline(
                query=args.get("query"),
                limit=args.get("limit", 20),
            )
        if tool_name == "plur_status":
            return bridge.status()
        if tool_name == "plur_sync":
            return bridge.sync()
        if tool_name == "plur_ingest":
            return bridge.ingest(
                args["content"],
                source=args.get("source"),
                extract_only=args.get("extract_only", False),
                scope=args.get("scope"),
                domain=args.get("domain"),
            )
        if tool_name == "plur_packs_list":
            return bridge.packs_list()
        if tool_name == "plur_packs_install":
            return bridge.packs_install(args["source"])
        if tool_name == "plur_packs_export":
            export_args = [args["name"]]
            if args.get("domain"):
                export_args.extend(["--domain", args["domain"]])
            if args.get("scope"):
                export_args.extend(["--scope", args["scope"]])
            return bridge.call("packs", ["export"] + export_args)
        if tool_name == "plur_promote":
            return bridge.promote(args["id"])
        if tool_name == "plur_stores_add":
            return bridge.stores_add(
                args["path"],
                scope=args.get("scope", "global"),
                shared=args.get("shared", False),
                readonly=args.get("readonly", False),
            )
        if tool_name == "plur_stores_list":
            return bridge.stores_list()
        if tool_name == "plur_similarity_search":
            return bridge.similarity_search(
                args["query"],
                limit=args.get("limit", 10),
                scope=args.get("scope"),
            )
        return {"error": f"Unknown tool: {tool_name}"}

    def get_config_schema(self) -> List[Dict[str, Any]]:
        """Return config fields for ``hermes memory setup``.

        PLUR stores its config in ``~/.plur/`` (or ``$PLUR_PATH``).  The
        only configurable surface exposed to Hermes is the path override, which
        is already handled via the ``PLUR_PATH`` env var.  All other options
        (inject mode, feedback, dedup TTL) are env-var-only to avoid
        polluting config.yaml with PLUR internals.
        """
        return [
            {
                "key": "plur_path",
                "description": (
                    "Path to your PLUR engram store (default: ~/.plur). "
                    "Leave blank to use the default or $PLUR_PATH env var."
                ),
                "secret": False,
                "required": False,
                "default": "",
                "env_var": "PLUR_PATH",
            },
            {
                "key": "plur_inject_mode",
                "description": (
                    "Engram retrieval mode for prefetch. "
                    "\"fast\" uses BM25-only (default, low latency). "
                    "\"hybrid\" uses BM25 + embeddings (higher quality, ~2s)."
                ),
                "secret": False,
                "required": False,
                "default": "fast",
                "choices": ["fast", "hybrid"],
                "env_var": "PLUR_INJECT_MODE",
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """No-op: PLUR config is env-var-only; ``get_config_schema`` sets ``env_var``."""


def create_memory_provider(bridge: Optional[PlurBridge] = None) -> PlurMemoryProvider:
    """Factory used by the ``hermes_agent.memory_providers`` entry point.

    Hermes calls the entry point to obtain a provider instance.  Accepting
    an optional ``bridge`` lets the standalone plugin path share its bridge
    when both paths are active in the same process.
    """
    return PlurMemoryProvider(bridge=bridge)
