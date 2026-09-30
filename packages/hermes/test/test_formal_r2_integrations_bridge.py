"""Formal verification round 2 (R2-Integrations, mcp-integrations#5 + follow-ups).

The bridge's dedup must never swallow a write that core would have stored:
core's content-hash dedup is scope-aware (a statement in another scope is a new
engram), so the bridge's shortcut must be too. forget must drop cache entries.
Tool paths must not hard-code scope "global" (that defeats auto-route, the
contract bridge.learn documents). A recall query starting with "-" travels
after "--" so the CLI cannot read it as a flag.

Model: spec/formal/PlurSpec/R2Integrations.lean §2.
"""
import json
import os
from unittest.mock import MagicMock, patch

from plur_hermes.bridge import PlurBridge


def _ok(payload):
    m = MagicMock()
    m.returncode = 0
    m.stdout = json.dumps(payload)
    m.stderr = ""
    return m


def _bridge():
    b = PlurBridge()
    b._binary = "/usr/local/bin/plur"
    b._plur_path = None
    return b


def test_team_scoped_learn_not_swallowed_by_cached_personal_one():
    b = _bridge()
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok({"results": []}), _ok({"id": "ENG-1", "statement": "Deploy on Fridays is banned", "scope": "user:alice"})]):
        b.learn("Deploy on Fridays is banned", scope="user:alice")
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok({"results": []}), _ok({"id": "ENG-2", "statement": "Deploy on Fridays is banned"})]) as run:
        r = b.learn("Deploy on Fridays is banned", scope="group:acme/eng")
    assert "deduplicated" not in r, r
    assert r["id"] == "ENG-2"
    learn_cmd = run.call_args_list[-1][0][0]
    assert "learn" in learn_cmd and "group:acme/eng" in learn_cmd


def test_recall_hit_in_another_scope_is_not_a_duplicate():
    b = _bridge()
    hit = {"results": [{"id": "ENG-9", "statement": "Use pnpm", "scope": "user:alice"}]}
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok(hit), _ok({"id": "ENG-10", "statement": "Use pnpm"})]) as run:
        r = b.learn("Use pnpm", scope="group:acme/eng")
    assert r["id"] == "ENG-10" and "deduplicated" not in r
    assert run.call_count == 2


def test_recall_hit_in_the_same_scope_is_a_duplicate():
    b = _bridge()
    hit = {"results": [{"id": "ENG-9", "statement": "Use pnpm", "scope": "group:acme/eng"}]}
    with patch("plur_hermes.bridge._run_in_process_group", side_effect=[_ok(hit)]) as run:
        r = b.learn("Use pnpm", scope="group:acme/eng")
    assert r["deduplicated"] is True and r["id"] == "ENG-9"
    assert run.call_count == 1


def test_unscoped_learn_lets_core_decide():
    # The bridge cannot know where core's auto-route sends an unscoped write,
    # so a recall hit anywhere must not stand in for core's own (scoped) dedup.
    b = _bridge()
    # Before the fix a scope-blind recall ran first and a hit anywhere
    # (e.g. user:alice) returned deduplicated without writing.
    hit = {"results": [{"id": "ENG-9", "statement": "Use pnpm", "scope": "user:alice"}]}
    learned = {"id": "ENG-11", "statement": "Use pnpm"}
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=lambda cmd, *a, **k: _ok(hit if "recall" in cmd else learned)) as run:
        r = b.learn("Use pnpm")
    assert r["id"] == "ENG-11" and "deduplicated" not in r
    assert [c[0][0][1] for c in run.call_args_list] == ["learn"]


def test_forget_drops_cached_entry():
    b = _bridge()
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok({"results": []}), _ok({"id": "ENG-5", "statement": "Cache me"})]):
        b.learn("Cache me", scope="global")
    with patch("plur_hermes.bridge._run_in_process_group", side_effect=[_ok({"retired": "ENG-5"})]):
        b.forget(id="ENG-5")
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok({"results": []}), _ok({"id": "ENG-6", "statement": "Cache me"})]) as run:
        r = b.learn("Cache me", scope="global")
    assert r["id"] == "ENG-6" and "deduplicated" not in r
    assert run.call_count == 2


def test_forget_by_search_drops_cached_entries():
    b = _bridge()
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok({"results": []}), _ok({"id": "ENG-5", "statement": "Cache me"})]):
        b.learn("Cache me", scope="global")
    with patch("plur_hermes.bridge._run_in_process_group", side_effect=[_ok({"retired": ["ENG-5"]})]):
        b.forget(search="cache")
    with patch("plur_hermes.bridge._run_in_process_group",
               side_effect=[_ok({"results": []}), _ok({"id": "ENG-7", "statement": "Cache me"})]) as run:
        b.learn("Cache me", scope="global")
    assert run.call_count == 2


def test_memory_provider_tool_learn_omits_scope_when_caller_does():
    from plur_hermes.memory_provider import PlurMemoryProvider
    bridge = MagicMock()
    bridge.learn.return_value = {"id": "ENG-1"}
    p = PlurMemoryProvider(bridge=bridge)
    p.handle_tool_call("plur_learn", {"statement": "x"})
    assert bridge.learn.call_args.kwargs["scope"] is None


def test_plugin_tool_learn_omits_scope_when_caller_does():
    import plur_hermes

    class Ctx:
        def __init__(self):
            self.hooks, self.tools = {}, {}

        def register_hook(self, name, fn):
            self.hooks[name] = fn

        def register_tool(self, name, toolset, schema, handler):
            self.tools[name] = (schema, handler)

    bridge = MagicMock()
    bridge._plur_path = None
    bridge.status.return_value = {"engram_count": 0}
    bridge.learn.return_value = {"id": "ENG-1"}
    with patch("plur_hermes.PlurBridge", return_value=bridge), patch("plur_hermes._install_skill"):
        ctx = Ctx()
        plur_hermes.register(ctx)
        schema, handler = ctx.tools["plur_learn"]
        handler({"statement": "x"})
    assert bridge.learn.call_args.kwargs["scope"] is None
    assert schema["parameters"]["properties"]["scope"].get("default") is None


def test_recall_query_starting_with_dash_goes_after_separator():
    b = _bridge()
    b._plur_path = "/tmp/p"
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"results": []})) as run:
        b.recall("--dry-run flag conventions", limit=3)
    cmd = run.call_args[0][0]
    sep = cmd.index("--")
    assert cmd[sep + 1:] == ["--dry-run flag conventions"], cmd
    assert "--path" in cmd[:sep] and "--limit" in cmd[:sep]


def test_ordinary_recall_query_argv_unchanged():
    b = _bridge()
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"results": []})) as run:
        b.recall("deploy checklist", limit=3)
    cmd = run.call_args[0][0]
    assert "--" not in cmd
    assert cmd[cmd.index("recall") + 2] == "deploy checklist"
