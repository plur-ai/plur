"""PLUR persistent memory plugin for Hermes Agent."""

import json
import os
import shutil
import time
from pathlib import Path

from .bridge import PlurBridge, PlurNotFoundError
from .learner import extract_learning_patterns

__version__ = "0.1.0"

_session_state: dict[str, dict] = {}
_PRUNE_AGE_SECONDS = 3600


def _prune_stale_sessions():
    now = time.time()
    stale = [sid for sid, s in _session_state.items() if now - s.get("started", 0) > _PRUNE_AGE_SECONDS]
    for sid in stale:
        del _session_state[sid]


def _install_skill(plugin_dir: Path):
    skills_dir = Path.home() / ".hermes" / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    bundled = plugin_dir / "skills" / "plur-memory.SKILL.md"
    installed = skills_dir / "plur-memory.SKILL.md"
    if not bundled.exists():
        return

    def _get_version(path: Path) -> str:
        try:
            for line in path.read_text().splitlines():
                if line.strip().startswith("version:"):
                    return line.split(":", 1)[1].strip()
        except Exception:
            pass
        return "0.0.0"

    if installed.exists():
        if _get_version(installed) >= _get_version(bundled):
            return
    shutil.copy2(bundled, installed)


def register(ctx):
    """Plugin entry point — called by Hermes on startup."""
    bridge = PlurBridge()

    # Verify CLI
    try:
        status = bridge.status()
        ctx.logger.info(f"PLUR: connected — {status.get('engram_count', '?')} engrams")
    except PlurNotFoundError:
        ctx.logger.error("PLUR CLI not found. Install: npm install -g @plur-ai/cli")
        return

    # Install SKILL.md
    _install_skill(Path(__file__).parent)

    # --- Hooks ---
    def on_session_start(session_id, **kwargs):
        _prune_stale_sessions()
        _session_state[session_id] = {"count": 0, "started": time.time()}
        try:
            s = bridge.status()
            ctx.logger.info(f"PLUR session: {s.get('engram_count', '?')} engrams available")
        except Exception:
            pass

    def pre_llm_call(session_id, user_message, **kwargs):
        if not user_message:
            return
        try:
            mode = os.environ.get("PLUR_INJECT_MODE", "fast")
            fast = mode != "hybrid"
            result = bridge.inject(user_message, fast=fast)
            if result.get("count", 0) == 0:
                return
            lines = ["<plur-memory>"]
            if result.get("directives"):
                lines.append(result["directives"])
            if result.get("constraints"):
                lines.append(result["constraints"])
            if result.get("consider"):
                lines.append(result["consider"])
            lines.append("</plur-memory>")
            return {"context": "\n".join(lines)}
        except Exception as e:
            ctx.logger.debug(f"PLUR inject failed: {e}")
            return None

    def post_llm_call(session_id, assistant_response, **kwargs):
        try:
            learnings = extract_learning_patterns(assistant_response or "")
            for statement in learnings:
                bridge.learn(statement, source="hermes:auto")
                if session_id in _session_state:
                    _session_state[session_id]["count"] += 1
        except Exception as e:
            ctx.logger.debug(f"PLUR learning extraction failed: {e}")

    def on_session_end(session_id, completed=False, interrupted=False, **kwargs):
        try:
            parts = [f"Hermes session {session_id}"]
            if interrupted:
                parts.append("(interrupted)")
            session = _session_state.get(session_id, {})
            learn_count = session.get("count", 0)
            if learn_count:
                parts.append(f"— {learn_count} learnings captured")
            platform = kwargs.get("platform", "unknown")
            parts.append(f"[{platform}]")
            bridge.capture(" ".join(parts), agent="hermes", session=session_id)
        except Exception as e:
            ctx.logger.debug(f"PLUR session capture failed: {e}")
        finally:
            _session_state.pop(session_id, None)

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("on_session_end", on_session_end)

    # --- Tools ---
    TOOL_SCHEMAS = {
        "plur_learn": {
            "description": "Create a new engram — store a correction, preference, pattern, or decision",
            "parameters": {
                "type": "object",
                "properties": {
                    "statement": {"type": "string", "description": "The knowledge assertion"},
                    "scope": {"type": "string", "default": "global"},
                    "type": {"type": "string", "enum": ["behavioral", "terminological", "procedural", "architectural"], "default": "behavioral"},
                    "domain": {"type": "string"},
                },
                "required": ["statement"],
            },
        },
        "plur_recall": {
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
        "plur_inject": {
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
        "plur_list": {
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
        "plur_forget": {
            "description": "Retire an engram by ID",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "reason": {"type": "string"}}, "required": ["id"]},
        },
        "plur_feedback": {
            "description": "Rate an engram (positive|negative|neutral)",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "signal": {"type": "string", "enum": ["positive", "negative", "neutral"]}}, "required": ["id", "signal"]},
        },
        "plur_capture": {
            "description": "Record an episode to the timeline",
            "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]},
        },
        "plur_timeline": {
            "description": "Query the episodic timeline",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 20}}},
        },
        "plur_status": {
            "description": "Check PLUR system health",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_sync": {
            "description": "Cross-device sync via git",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_packs_list": {
            "description": "List installed engram packs",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_packs_install": {
            "description": "Install an engram pack",
            "parameters": {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]},
        },
    }

    def _make_handler(tool_name: str):
        def handler(args: dict, **kwargs) -> str:
            try:
                if tool_name == "plur_learn":
                    result = bridge.learn(args["statement"], scope=args.get("scope", "global"),
                                          type=args.get("type", "behavioral"), domain=args.get("domain"))
                elif tool_name == "plur_recall":
                    result = bridge.recall(args["query"], limit=args.get("limit", 10), fast=args.get("fast", False))
                elif tool_name == "plur_inject":
                    result = bridge.inject(args["task"], budget=args.get("budget", 2000), fast=args.get("fast", False))
                elif tool_name == "plur_list":
                    result = bridge.list_engrams(domain=args.get("domain"), type=args.get("type"),
                                                  scope=args.get("scope"), limit=args.get("limit"), meta=args.get("meta", False))
                elif tool_name == "plur_forget":
                    result = bridge.forget(args["id"], reason=args.get("reason"))
                elif tool_name == "plur_feedback":
                    result = bridge.feedback(args["id"], args["signal"])
                elif tool_name == "plur_capture":
                    result = bridge.capture(args["summary"])
                elif tool_name == "plur_timeline":
                    result = bridge.timeline(query=args.get("query"), limit=args.get("limit", 20))
                elif tool_name == "plur_status":
                    result = bridge.status()
                elif tool_name == "plur_sync":
                    result = bridge.sync()
                elif tool_name == "plur_packs_list":
                    result = bridge.packs_list()
                elif tool_name == "plur_packs_install":
                    result = bridge.packs_install(args["source"])
                else:
                    result = {"error": f"Unknown tool: {tool_name}"}
                return json.dumps(result)
            except Exception as e:
                return json.dumps({"error": str(e)})
        return handler

    for name, schema in TOOL_SCHEMAS.items():
        ctx.register_tool(name=name, toolset="plur", schema=schema, handler=_make_handler(name))

    ctx.logger.info(f"PLUR registered: 4 hooks + {len(TOOL_SCHEMAS)} tools")
