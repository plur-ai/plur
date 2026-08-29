"""Tests for PlurMemoryProvider — the MemoryProvider ABC adapter.

Coverage:
- ABC contract (name, is_available, initialize, get_tool_schemas,
  handle_tool_call, get_config_schema, save_config)
- prefetch: inject result → formatted context; empty when nothing relevant
- sync_turn: auto-learn + injection feedback; skips non-primary contexts
- on_session_end: capture call at real session boundary
- system_prompt_block: status text; empty on bridge failure
- Bridge sharing: register_memory_provider() path in register()
- standalone_hooks_active: lifecycle methods are no-ops when True
- Entry point factory: create_memory_provider()
- Session keying: interleaved sessions do not cross-contaminate
- Feedback-disabled drain: pending list drained even when feedback off
"""

import json
import os
import threading
import pytest
from unittest.mock import MagicMock, patch, call

from plur_hermes.memory_provider import (
    PlurMemoryProvider,
    create_memory_provider,
    _PLUR_TOOL_SCHEMAS,
)
from plur_hermes.bridge import PlurBridgeError, PlurNotFoundError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_bridge(
    *,
    status_result=None,
    inject_result=None,
    learn_result=None,
    feedback_result=None,
    capture_result=None,
):
    bridge = MagicMock()
    bridge._plur_path = None
    bridge.status.return_value = status_result or {"engram_count": 42}
    bridge.inject.return_value = inject_result or {"count": 0, "results": [], "injected_ids": []}
    bridge.learn.return_value = learn_result or {"id": "ENG-NEW"}
    bridge.feedback.return_value = feedback_result or {"ok": True}
    bridge.capture.return_value = capture_result or {"ok": True}
    return bridge


def _provider(bridge=None):
    b = bridge or _mock_bridge()
    return PlurMemoryProvider(bridge=b), b


def _set_pending(p: PlurMemoryProvider, engrams: list, session_key: str = "") -> None:
    """Helper: pre-populate the pending list for a session (as prefetch() would)."""
    with p._injected_lock:
        p._pending_by_session[session_key] = list(engrams)


def _get_pending(p: PlurMemoryProvider, session_key: str = "") -> list:
    with p._injected_lock:
        return list(p._pending_by_session.get(session_key, []))


# ---------------------------------------------------------------------------
# ABC contract
# ---------------------------------------------------------------------------

class TestAbcContract:
    def test_name(self):
        p, _ = _provider()
        assert p.name == "plur"

    def test_is_available_true(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        assert p.is_available() is True
        bridge.status.assert_called_once()

    def test_is_available_caches_result(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p.is_available()
        p.is_available()
        bridge.status.assert_called_once()  # cached after first call

    def test_is_available_false_on_bridge_error(self):
        bridge = _mock_bridge()
        bridge.status.side_effect = PlurNotFoundError("not found")
        p = PlurMemoryProvider(bridge=bridge)
        assert p.is_available() is False

    def test_initialize_logs_engrams(self, caplog):
        bridge = _mock_bridge(status_result={"engram_count": 99})
        p = PlurMemoryProvider(bridge=bridge)
        with caplog.at_level("INFO", logger="plur_hermes.memory_provider"):
            p.initialize("session-abc", platform="cli")
        assert "99" in caplog.text
        assert p._session_id == "session-abc"
        assert p._platform == "cli"

    def test_initialize_survives_bridge_failure(self):
        bridge = _mock_bridge()
        bridge.status.side_effect = PlurBridgeError("fail")
        p = PlurMemoryProvider(bridge=bridge)
        # Must not raise
        p.initialize("session-xyz")
        assert p._session_id == "session-xyz"

    def test_initialize_does_not_wipe_other_sessions(self):
        """Initializing session B must not clear session A's pending list."""
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p.initialize("sess-A")
        _set_pending(p, [{"id": "E1", "statement": "stmt"}], "sess-A")
        p.initialize("sess-B")
        # sess-A's data survives
        assert _get_pending(p, "sess-A") == [{"id": "E1", "statement": "stmt"}]

    def test_get_tool_schemas_returns_all(self):
        p, _ = _provider()
        schemas = p.get_tool_schemas()
        names = {s["name"] for s in schemas}
        assert "plur_learn" in names
        assert "plur_recall" in names
        assert "plur_inject" in names
        assert "plur_forget" in names
        assert "plur_feedback" in names
        assert "plur_status" in names
        # Meta tools
        assert "plur_extract_meta" in names
        assert "plur_meta_engrams" in names
        assert "plur_validate_meta" in names
        assert "plur_meta_submit_analysis" in names
        assert len(schemas) == len(_PLUR_TOOL_SCHEMAS)
        assert len(schemas) == 22

    def test_get_tool_schemas_is_copy(self):
        p, _ = _provider()
        s1 = p.get_tool_schemas()
        s2 = p.get_tool_schemas()
        assert s1 is not s2

    def test_get_config_schema_returns_list(self):
        p, _ = _provider()
        schema = p.get_config_schema()
        assert isinstance(schema, list)
        keys = {f["key"] for f in schema}
        assert "plur_path" in keys
        assert "plur_inject_mode" in keys

    def test_save_config_is_noop(self):
        p, _ = _provider()
        # Must not raise
        p.save_config({"plur_path": "/tmp/plur"}, hermes_home="/tmp/hermes")


# ---------------------------------------------------------------------------
# handle_tool_call dispatch
# ---------------------------------------------------------------------------

class TestHandleToolCall:
    def test_plur_learn(self):
        bridge = _mock_bridge()
        bridge.learn.return_value = {"id": "ENG-001", "statement": "test"}
        p = PlurMemoryProvider(bridge=bridge)
        result = json.loads(p.handle_tool_call("plur_learn", {"statement": "test stmt"}))
        bridge.learn.assert_called_once_with(
            "test stmt",
            scope="global",
            type="behavioral",
            domain=None,
            tags=None,
            rationale=None,
            visibility=None,
            knowledge_anchors=None,
            dual_coding=None,
            abstract=None,
            derived_from=None,
            force=False,
        )
        assert result["id"] == "ENG-001"

    def test_plur_recall(self):
        bridge = _mock_bridge()
        bridge.recall.return_value = {"results": [{"id": "E1"}], "count": 1}
        p = PlurMemoryProvider(bridge=bridge)
        result = json.loads(p.handle_tool_call("plur_recall", {"query": "memory test"}))
        bridge.recall.assert_called_once_with("memory test", limit=10, fast=False)
        assert result["count"] == 1

    def test_plur_inject(self):
        bridge = _mock_bridge()
        bridge.inject.return_value = {"count": 2, "results": [], "directives": "..."}
        p = PlurMemoryProvider(bridge=bridge)
        result = json.loads(p.handle_tool_call("plur_inject", {"task": "some task"}))
        bridge.inject.assert_called_once_with("some task", budget=2000, fast=False)
        assert result["count"] == 2

    def test_plur_feedback_batch(self):
        bridge = _mock_bridge()
        bridge.feedback.return_value = {"ok": True}
        p = PlurMemoryProvider(bridge=bridge)
        args = {"batch": [{"id": "E1", "signal": "positive"}, {"id": "E2", "signal": "negative"}]}
        p.handle_tool_call("plur_feedback", args)
        bridge.feedback.assert_called_once_with(batch=[("E1", "positive"), ("E2", "negative")])

    def test_plur_feedback_single(self):
        bridge = _mock_bridge()
        bridge.feedback.return_value = {"ok": True}
        p = PlurMemoryProvider(bridge=bridge)
        p.handle_tool_call("plur_feedback", {"id": "ENG-001", "signal": "positive"})
        bridge.feedback.assert_called_once_with("ENG-001", "positive")

    def test_plur_status(self):
        bridge = _mock_bridge(status_result={"engram_count": 5})
        p = PlurMemoryProvider(bridge=bridge)
        result = json.loads(p.handle_tool_call("plur_status", {}))
        assert result["engram_count"] == 5

    def test_plur_stores_add(self):
        bridge = _mock_bridge()
        bridge.stores_add.return_value = {"ok": True}
        p = PlurMemoryProvider(bridge=bridge)
        p.handle_tool_call("plur_stores_add", {"path": "/tmp/store"})
        bridge.stores_add.assert_called_once_with(
            "/tmp/store", scope="global", shared=False, readonly=False
        )

    def test_plur_similarity_search(self):
        bridge = _mock_bridge()
        bridge.similarity_search.return_value = {"results": [], "count": 0}
        p = PlurMemoryProvider(bridge=bridge)
        p.handle_tool_call("plur_similarity_search", {"query": "test"})
        bridge.similarity_search.assert_called_once_with("test", limit=10, scope=None)

    def test_plur_meta_engrams(self):
        bridge = _mock_bridge()
        bridge.list_engrams.return_value = {"results": [], "count": 0}
        p = PlurMemoryProvider(bridge=bridge)
        p.handle_tool_call("plur_meta_engrams", {})
        bridge.list_engrams.assert_called_once_with(meta=True, domain=None)

    def test_plur_validate_meta(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        result = json.loads(p.handle_tool_call(
            "plur_validate_meta", {"id": "META-001", "domain": "engineering"}
        ))
        assert result["status"] == "prompts_ready"
        assert isinstance(result["prompts"], list)
        assert len(result["prompts"]) >= 1

    def test_unknown_tool_returns_error(self):
        p, _ = _provider()
        result = json.loads(p.handle_tool_call("plur_nonexistent", {}))
        assert "error" in result

    def test_bridge_exception_returns_error_json(self):
        bridge = _mock_bridge()
        bridge.recall.side_effect = PlurBridgeError("boom")
        p = PlurMemoryProvider(bridge=bridge)
        result = json.loads(p.handle_tool_call("plur_recall", {"query": "x"}))
        assert "error" in result


# ---------------------------------------------------------------------------
# prefetch
# ---------------------------------------------------------------------------

class TestPrefetch:
    def test_returns_directives_when_injected(self):
        bridge = _mock_bridge(inject_result={
            "count": 1,
            "results": [{"id": "E1", "statement": "always use pnpm"}],
            "injected_ids": ["E1"],
            "directives": "always use pnpm",
        })
        p = PlurMemoryProvider(bridge=bridge)
        result = p.prefetch("what package manager")
        assert "always use pnpm" in result

    def test_returns_empty_when_nothing_relevant(self):
        bridge = _mock_bridge(inject_result={"count": 0, "results": [], "injected_ids": []})
        p = PlurMemoryProvider(bridge=bridge)
        result = p.prefetch("some query")
        assert result == ""

    def test_returns_empty_on_bridge_failure(self):
        bridge = _mock_bridge()
        bridge.inject.side_effect = PlurBridgeError("inject fail")
        p = PlurMemoryProvider(bridge=bridge)
        result = p.prefetch("test")
        assert result == ""

    def test_stores_injected_engrams_for_feedback(self):
        bridge = _mock_bridge(inject_result={
            "count": 1,
            "results": [{"id": "E1", "statement": "always use pnpm not npm"}],
            "injected_ids": ["E1"],
            "directives": "always use pnpm not npm",
        })
        p = PlurMemoryProvider(bridge=bridge)
        p.prefetch("package manager")
        assert len(_get_pending(p, "")) == 1
        assert _get_pending(p, "")[0]["id"] == "E1"

    def test_stores_injected_engrams_keyed_by_session(self):
        bridge = _mock_bridge(inject_result={
            "count": 1,
            "results": [{"id": "E1", "statement": "use pnpm"}],
            "injected_ids": ["E1"],
            "directives": "use pnpm",
        })
        p = PlurMemoryProvider(bridge=bridge)
        p.prefetch("package manager", session_id="sess-A")
        # Only session A's bucket is populated
        assert len(_get_pending(p, "sess-A")) == 1
        assert _get_pending(p, "") == []

    def test_fast_mode_by_default(self):
        bridge = _mock_bridge(inject_result={"count": 0, "results": [], "injected_ids": []})
        p = PlurMemoryProvider(bridge=bridge)
        with patch.dict(os.environ, {}, clear=True):
            # Remove PLUR_INJECT_MODE if set; default is fast=True
            os.environ.pop("PLUR_INJECT_MODE", None)
            p.prefetch("query")
        bridge.inject.assert_called_once_with("query", fast=True)

    @patch.dict(os.environ, {"PLUR_INJECT_MODE": "hybrid"})
    def test_hybrid_mode_via_env(self):
        bridge = _mock_bridge(inject_result={"count": 0, "results": [], "injected_ids": []})
        p = PlurMemoryProvider(bridge=bridge)
        p.prefetch("query")
        bridge.inject.assert_called_once_with("query", fast=False)

    def test_empty_query_skips_bridge(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        result = p.prefetch("")
        bridge.inject.assert_not_called()
        assert result == ""

    def test_noop_when_standalone_hooks_active(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge, standalone_hooks_active=True)
        result = p.prefetch("query")
        bridge.inject.assert_not_called()
        assert result == ""


# ---------------------------------------------------------------------------
# sync_turn
# ---------------------------------------------------------------------------

class TestSyncTurn:
    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_autolearn_fires_on_primary_context(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        response = "I learned:\n- always use pnpm not npm\n"
        p.sync_turn("user msg", response)
        bridge.learn.assert_called()

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_skips_writes_on_cron_context(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "cron"
        p.sync_turn("user msg", "I learned:\n- use pnpm not npm")
        bridge.learn.assert_not_called()

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_positive_feedback_sent(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        # Pre-populate injected engrams (as prefetch() would).
        _set_pending(p, [{"id": "E1", "statement": "always use pnpm not npm"}])
        response = "I'll always use pnpm not npm as requested."
        p.sync_turn("what package manager?", response)
        bridge.feedback.assert_called_once()
        batch = bridge.feedback.call_args[1]["batch"]
        assert ("E1", "positive") in batch

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_injected_engrams_cleared_after_feedback(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        _set_pending(p, [{"id": "E1", "statement": "always use pnpm not npm"}])
        p.sync_turn("msg", "always use pnpm not npm")
        assert _get_pending(p) == []

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "false"})
    def test_feedback_disabled_still_drains_pending_list(self):
        """Pending list must be drained even when feedback is disabled (no leak)."""
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        _set_pending(p, [{"id": "E1", "statement": "always use pnpm not npm"}])
        p.sync_turn("msg", "always use pnpm not npm")
        bridge.feedback.assert_not_called()
        # List must be empty — not growing
        assert _get_pending(p) == []

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_no_feedback_on_unrelated_response(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        _set_pending(p, [{"id": "E1", "statement": "always use pnpm not npm"}])
        p.sync_turn("msg", "The sky is blue and the sun is bright today.")
        bridge.feedback.assert_not_called()

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_sync_turn_increments_learn_count(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        # trigger strategy-2 marker
        p.sync_turn("msg", "I learned:\n- use black for formatting")
        assert p._learn_by_session.get("", 0) >= 1

    def test_noop_when_standalone_hooks_active(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge, standalone_hooks_active=True)
        p._agent_context = "primary"
        _set_pending(p, [{"id": "E1", "statement": "use pnpm"}])
        p.sync_turn("msg", "use pnpm not npm")
        bridge.learn.assert_not_called()
        bridge.feedback.assert_not_called()

    def test_bridge_construction_failure_is_non_fatal(self):
        """A malformed PLUR_BRIDGE_TIMEOUT must never propagate to the caller."""
        p = PlurMemoryProvider(bridge=None)  # bridge is None → _get_bridge() creates one
        p._agent_context = "primary"

        # Patch PlurBridge.__init__ to raise ValueError (like a bad env var would)
        with patch("plur_hermes.memory_provider.PlurBridge", side_effect=ValueError("bad timeout")):
            # Must not raise
            p.sync_turn("user msg", "assistant response")

    def test_session_keyed_pending_lists(self):
        """sync_turn drains only the calling session's pending list."""
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"
        _set_pending(p, [{"id": "E1", "statement": "sess-A stmt"}], "sess-A")
        _set_pending(p, [{"id": "E2", "statement": "sess-B stmt"}], "sess-B")
        with patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "false"}):
            p.sync_turn("msg", "response", session_id="sess-A")
        # sess-A's list was drained; sess-B's is untouched
        assert _get_pending(p, "sess-A") == []
        assert len(_get_pending(p, "sess-B")) == 1


# ---------------------------------------------------------------------------
# on_session_end
# ---------------------------------------------------------------------------

class TestOnSessionEnd:
    def test_capture_called_with_session_info(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._session_id = "sess-001"
        p._platform = "cli"
        p._learn_by_session["sess-001"] = 3
        p.on_session_end([])
        bridge.capture.assert_called_once()
        args = bridge.capture.call_args
        call_args_str = str(args)
        assert "sess-001" in call_args_str or "hermes" in call_args_str

    def test_state_reset_after_end(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._session_id = "sess-001"
        p._learn_by_session["sess-001"] = 5
        p.on_session_end([])
        assert p._session_id == ""
        assert p._learn_by_session.get("sess-001") is None

    def test_pending_list_cleared_on_session_end(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge)
        p._session_id = "sess-001"
        _set_pending(p, [{"id": "E1", "statement": "leftover"}], "sess-001")
        p.on_session_end([])
        assert _get_pending(p, "sess-001") == []

    def test_survives_capture_failure(self):
        bridge = _mock_bridge()
        bridge.capture.side_effect = PlurBridgeError("capture fail")
        p = PlurMemoryProvider(bridge=bridge)
        p._session_id = "sess-002"
        # Must not raise
        p.on_session_end([])
        assert p._session_id == ""  # reset still happens in finally

    def test_noop_when_standalone_hooks_active(self):
        bridge = _mock_bridge()
        p = PlurMemoryProvider(bridge=bridge, standalone_hooks_active=True)
        p._session_id = "sess-003"
        p.on_session_end([])
        bridge.capture.assert_not_called()


# ---------------------------------------------------------------------------
# system_prompt_block
# ---------------------------------------------------------------------------

class TestSystemPromptBlock:
    def test_includes_engram_count(self):
        bridge = _mock_bridge(status_result={"engram_count": 77})
        p = PlurMemoryProvider(bridge=bridge)
        block = p.system_prompt_block()
        assert "77" in block

    def test_empty_on_bridge_failure(self):
        bridge = _mock_bridge()
        bridge.status.side_effect = PlurBridgeError("fail")
        p = PlurMemoryProvider(bridge=bridge)
        assert p.system_prompt_block() == ""

    def test_empty_when_count_missing(self):
        bridge = _mock_bridge(status_result={"ok": True})  # no engram_count
        p = PlurMemoryProvider(bridge=bridge)
        assert p.system_prompt_block() == ""

    def test_active_when_standalone_hooks_active(self):
        """system_prompt_block works regardless of standalone_hooks_active."""
        bridge = _mock_bridge(status_result={"engram_count": 5})
        p = PlurMemoryProvider(bridge=bridge, standalone_hooks_active=True)
        block = p.system_prompt_block()
        assert "5" in block


# ---------------------------------------------------------------------------
# register() integration — register_memory_provider path
# ---------------------------------------------------------------------------

class TestRegisterIntegration:
    """Verify that register() calls ctx.register_memory_provider when available."""

    def _make_ctx(self):
        class Ctx:
            def __init__(self):
                self.hooks = {}
                self.tools = {}
                self.memory_provider = None

            def register_hook(self, name, fn):
                self.hooks[name] = fn

            def register_tool(self, name, toolset, schema, handler):
                self.tools[name] = handler

            def register_memory_provider(self, provider):
                self.memory_provider = provider

        return Ctx()

    def _make_bridge(self):
        bridge = MagicMock()
        bridge._plur_path = None
        bridge.status.return_value = {"engram_count": 10}
        bridge.inject.return_value = {"count": 0, "results": [], "injected_ids": []}
        bridge.learn.return_value = {"id": "ENG-NEW"}
        bridge.feedback.return_value = {"ok": True}
        return bridge

    def test_register_calls_register_memory_provider(self):
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
        assert ctx.memory_provider is not None
        assert isinstance(ctx.memory_provider, PlurMemoryProvider)

    def test_register_shares_bridge_instance(self):
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
        # Provider should use the same bridge object (shared, not a copy).
        assert ctx.memory_provider._bridge is bridge

    def test_register_sets_standalone_hooks_active(self):
        """Provider created by register() must have standalone_hooks_active=True."""
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
        assert ctx.memory_provider._standalone_hooks_active is True

    def test_register_skips_memory_provider_when_ctx_lacks_method(self):
        """Standalone plugin ctx has no register_memory_provider — must not raise."""
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            class StandaloneCtx:
                def __init__(self):
                    self.hooks = {}
                    self.tools = {}

                def register_hook(self, name, fn):
                    self.hooks[name] = fn

                def register_tool(self, name, toolset, schema, handler):
                    self.tools[name] = handler

            ctx = StandaloneCtx()
            # Must not raise
            plur_hermes.register(ctx)
            assert "on_session_start" in ctx.hooks  # hooks still registered


# ---------------------------------------------------------------------------
# Entry point factory
# ---------------------------------------------------------------------------

class TestEntryPointFactory:
    def test_create_memory_provider_returns_instance(self):
        provider = create_memory_provider()
        assert isinstance(provider, PlurMemoryProvider)
        assert provider.name == "plur"

    def test_create_memory_provider_accepts_bridge(self):
        bridge = _mock_bridge()
        provider = create_memory_provider(bridge=bridge)
        assert provider._bridge is bridge

    def test_create_memory_provider_lazy_bridge(self):
        provider = create_memory_provider()
        assert provider._bridge is None  # not yet created

    def test_create_memory_provider_hooks_not_active(self):
        """Entry-point factory must not set standalone_hooks_active."""
        provider = create_memory_provider()
        assert provider._standalone_hooks_active is False


# ---------------------------------------------------------------------------
# Thread safety
# ---------------------------------------------------------------------------

class TestThreadSafety:
    """Verify that _pending_by_session is safe under concurrent prefetch + sync_turn."""

    def test_concurrent_prefetch_and_sync(self):
        bridge = _mock_bridge(inject_result={
            "count": 1,
            "results": [{"id": "E1", "statement": "pnpm"}],
            "injected_ids": ["E1"],
            "directives": "pnpm",
        })
        p = PlurMemoryProvider(bridge=bridge)
        p._agent_context = "primary"

        errors = []

        def prefetch_loop():
            for _ in range(20):
                try:
                    p.prefetch("query")
                except Exception as e:
                    errors.append(e)

        def sync_loop():
            for _ in range(20):
                try:
                    p.sync_turn("msg", "pnpm not npm")
                except Exception as e:
                    errors.append(e)

        threads = [
            threading.Thread(target=prefetch_loop),
            threading.Thread(target=sync_loop),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"Thread-safety errors: {errors}"
