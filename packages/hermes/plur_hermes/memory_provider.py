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

When both paths are active in the same process (the default when plur-hermes
is installed and Hermes supports the memory_providers entry-point group),
``register()`` passes its bridge and sets ``standalone_hooks_active=True``
so the lifecycle methods (``prefetch``, ``sync_turn``, ``on_session_end``)
yield to the standalone hooks instead of duplicating inject/learn/feedback
calls.  The provider still exposes tools and ``system_prompt_block()``
regardless of this flag.

When only the MemoryProvider path is active (entry point, no standalone
plugin), the lifecycle methods operate independently.
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

# Tool schemas for the MemoryProvider path.  Covers the same 18 core tools as
# the standalone path plus the 4 meta-engram tools — total 22.
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
    # Meta-engram tools (4) — mirrors the standalone path's META_TOOL_SCHEMAS.
    {
        "name": "plur_extract_meta",
        "description": "Start meta-engram extraction — distills cross-domain principles",
        "parameters": {
            "type": "object",
            "properties": {"dry_run": {"type": "boolean", "default": False}},
        },
    },
    {
        "name": "plur_meta_submit_analysis",
        "description": "Submit analysis responses for active meta-extraction pipeline",
        "parameters": {
            "type": "object",
            "properties": {
                "responses": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["responses"],
        },
    },
    {
        "name": "plur_meta_engrams",
        "description": "List meta-engrams — cross-domain principles",
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "min_confidence": {"type": "number"},
            },
        },
    },
    {
        "name": "plur_validate_meta",
        "description": "Test a meta-engram against a new domain",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "domain": {"type": "string"},
            },
            "required": ["id", "domain"],
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
    """Heuristic signal detection for a single injected engram vs. assistant response."""
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
    provider exposes the same 22 PLUR tools as the standalone hook path and adds
    MemoryProvider-specific lifecycle integrations:

    - ``prefetch()``      — inject engrams relevant to the upcoming user turn
    - ``sync_turn()``     — auto-learn from completed turns (mirrors post_llm_call)
    - ``on_session_end()``— capture session episode at the real session boundary
    - ``system_prompt_block()`` — static PLUR status text in the system prompt

    ``standalone_hooks_active`` controls whether the lifecycle methods (prefetch,
    sync_turn, on_session_end) are active.  When both the standalone plugin path
    (hermes_agent.plugins) and this provider are active in the same process,
    ``register()`` sets this flag to ``True`` so the hooks handle inject/learn/
    feedback and the provider's lifecycle methods are no-ops.  This prevents
    double injection, double learning, and inflated feedback signals.  When only
    this provider is active (entry-point path, no standalone plugin),
    ``standalone_hooks_active=False`` (the default) gives the provider full
    lifecycle responsibility.

    Pending-engram state is keyed by ``session_id`` so interleaved sessions do
    not cross-contaminate each other's injection lists.
    """

    def __init__(
        self,
        bridge: Optional[PlurBridge] = None,
        *,
        standalone_hooks_active: bool = False,
    ) -> None:
        # Accept an injected bridge so the standalone plugin path can share
        # its bridge instance.  Fall back to creating a fresh one if called
        # directly (e.g. when loaded via hermes_agent.memory_providers entry
        # point without the standalone plugin also being active).
        self._bridge: Optional[PlurBridge] = bridge
        self._standalone_hooks_active = standalone_hooks_active
        self._available: Optional[bool] = None  # cached; None = not yet checked
        self._session_id: str = ""
        self._platform: str = "unknown"
        self._agent_context: str = "primary"
        # Keyed by session_id to prevent interleaved-session cross-contamination.
        self._pending_by_session: dict[str, list[dict]] = {}
        self._learn_by_session: dict[str, int] = {}
        self._injected_lock = threading.Lock()
        self._meta_pipeline: Any = None  # lazily created

    # -- Lazy bridge construction --------------------------------------------

    def _get_bridge(self) -> PlurBridge:
        if self._bridge is None:
            self._bridge = PlurBridge()
        return self._bridge

    # -- Lazy meta-pipeline --------------------------------------------------

    def _get_meta_pipeline(self) -> Any:
        if self._meta_pipeline is None:
            from .meta_pipeline import MetaPipeline
            bridge = self._get_bridge()
            self._meta_pipeline = MetaPipeline(bridge, plur_path=bridge._plur_path)
        return self._meta_pipeline

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
        Per-session state is initialised without clearing other active sessions.
        """
        self._session_id = session_id
        self._platform = kwargs.get("platform", "unknown")
        self._agent_context = kwargs.get("agent_context", "primary")
        with self._injected_lock:
            self._pending_by_session[session_id] = []
        self._learn_by_session[session_id] = 0
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

        No-op when ``standalone_hooks_active=True`` — the pre_llm_call hook
        handles injection and duplicating it would double-inject engrams.

        Uses the fast inject path (BM25 only) to stay under the tight
        per-turn deadline.  Switch to hybrid via ``PLUR_INJECT_MODE=hybrid``.
        Stores injected engram metadata so ``sync_turn`` can send feedback
        after the turn.  Keyed by ``session_id`` to keep concurrent sessions
        isolated.

        Returns formatted text for Hermes to include as context, or empty
        string if nothing relevant or on any bridge failure.
        """
        if self._standalone_hooks_active:
            return ""
        if not query:
            return ""
        session_key = session_id or self._session_id
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
                bucket = self._pending_by_session.setdefault(session_key, [])
                bucket.extend(new_engrams)

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

        No-op when ``standalone_hooks_active=True`` — the post_llm_call hook
        handles learning and feedback and duplicating it would send double
        signals for the same engrams.

        Mirrors the ``post_llm_call`` hook behaviour:
        1. Extract self-reported learnings from the assistant response.
        2. Send positive/negative feedback signals for injected engrams that
           appeared or were contradicted in the response.

        The session's pending-engram list is always drained at the start of
        this call, even when learning is skipped or feedback is disabled, so
        the list cannot grow without bound across turns.

        Only writes in the ``primary`` agent context — skipping cron and
        subagent contexts matches the standalone hook path's behaviour.
        """
        if self._standalone_hooks_active:
            return
        if self._agent_context != "primary":
            return

        session_key = session_id or self._session_id

        # Always drain the pending list for this session regardless of what
        # follows.  This prevents unbounded growth when feedback is disabled
        # or when the bridge is unavailable.
        with self._injected_lock:
            snapshot = self._pending_by_session.pop(session_key, [])

        response = assistant_content or ""

        # Bridge construction is inside a try so a malformed env var (e.g.
        # PLUR_BRIDGE_TIMEOUT=bad) cannot propagate into the host's turn loop.
        try:
            bridge = self._get_bridge()
        except Exception as e:
            logger.debug("PLUR sync_turn: bridge unavailable (non-fatal): %s", e)
            return

        # 1. Auto-learn from self-reported patterns.
        try:
            learnings = extract_learning_patterns(response)
            for statement in learnings:
                bridge.learn(
                    statement,
                    source="hermes:auto",
                    rationale="Auto-extracted from assistant self-report",
                )
                self._learn_by_session[session_key] = (
                    self._learn_by_session.get(session_key, 0) + 1
                )
        except Exception as e:
            logger.debug("PLUR sync_turn: learning extraction failed: %s", e)

        # 2. Injection feedback.
        if os.environ.get("PLUR_INJECTION_FEEDBACK", "true").lower() == "false":
            return
        try:
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

        No-op when ``standalone_hooks_active=True`` — the on_session_end hook
        handles episode capture.

        This fires at real session boundaries (``/reset``, ``/new``, CLI exit,
        gateway session expiry) — NOT after every turn.  Mirrors the
        ``on_session_end`` hook's capture call so both paths record the same
        episode regardless of which is active.
        """
        if self._standalone_hooks_active:
            return
        sid = self._session_id
        learn_count = self._learn_by_session.get(sid, 0)
        try:
            bridge = self._get_bridge()
            parts = [f"Hermes session {sid}"]
            if learn_count:
                parts.append(f"— {learn_count} learnings captured")
            parts.append(f"[{self._platform}]")
            bridge.capture(" ".join(parts), agent="hermes", session=sid)
        except Exception as e:
            logger.debug("PLUR on_session_end: capture failed: %s", e)
        finally:
            self._session_id = ""
            with self._injected_lock:
                self._pending_by_session.pop(sid, None)
            self._learn_by_session.pop(sid, None)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return the PLUR tool schemas for MemoryManager injection."""
        return list(_PLUR_TOOL_SCHEMAS)

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        """Dispatch a PLUR tool call from the MemoryManager routing layer."""
        try:
            bridge = self._get_bridge()
            result = self._dispatch(bridge, tool_name, args, **kwargs)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _dispatch(
        self, bridge: PlurBridge, tool_name: str, args: Dict[str, Any], **kwargs
    ) -> Any:
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
        # Meta-engram tools
        if tool_name == "plur_extract_meta":
            session_id = kwargs.get("session_id", self._session_id) or "default"
            pipeline = self._get_meta_pipeline()
            return pipeline.start_extraction(session_id, dry_run=args.get("dry_run", False))
        if tool_name == "plur_meta_submit_analysis":
            session_id = kwargs.get("session_id", self._session_id) or "default"
            pipeline = self._get_meta_pipeline()
            return pipeline.submit_analysis(session_id, args["responses"])
        if tool_name == "plur_meta_engrams":
            return bridge.list_engrams(meta=True, domain=args.get("domain"))
        if tool_name == "plur_validate_meta":
            return {
                "status": "prompts_ready",
                "prompts": [
                    f"Test this meta-engram in the domain '{args['domain']}':\n"
                    f"ID: {args['id']}\n\n"
                    f"Does the principle hold? Return JSON: "
                    f"{{\"holds\": true/false, \"evidence\": \"...\", \"confidence\": <0-1>}}"
                ],
            }
        return {"error": f"Unknown tool: {tool_name}"}

    def get_config_schema(self) -> List[Dict[str, Any]]:
        """Return config fields for ``hermes memory setup``."""
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

    Hermes calls the entry point to obtain a provider instance.  When only
    this entry point is active (no standalone plugin), ``standalone_hooks_active``
    defaults to ``False`` so the lifecycle methods handle inject/learn/feedback.

    When both entry points are active, ``register()`` calls
    ``ctx.register_memory_provider(PlurMemoryProvider(bridge=bridge,
    standalone_hooks_active=True))``, which replaces any entry-point instance
    with a shared-bridge, hooks-deferring one.
    """
    return PlurMemoryProvider(bridge=bridge)
