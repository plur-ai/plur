"""PLUR persistent memory plugin for Hermes Agent."""

import json
import logging
import os
import shutil
import time
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path

from .bridge import PlurBridge, PlurNotFoundError
from .learner import extract_learning_patterns

logger = logging.getLogger("plur_hermes")

try:
    __version__ = _pkg_version("plur-hermes")
except PackageNotFoundError:
    __version__ = "0.0.0+unknown"

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

    def _get_version(path: Path) -> tuple[int, ...]:
        try:
            for line in path.read_text().splitlines():
                if line.strip().startswith("version:"):
                    ver_str = line.split(":", 1)[1].strip()
                    return tuple(int(x) for x in ver_str.split("."))
        except Exception:
            pass
        return (0, 0, 0)

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
        logger.info(f"PLUR: connected — {status.get('engram_count', '?')} engrams")
    except PlurNotFoundError as e:
        logger.error(str(e))
        return

    # Install SKILL.md
    _install_skill(Path(__file__).parent)

    # --- Hooks ---
    def on_session_start(session_id, **kwargs):
        _prune_stale_sessions()
        _session_state[session_id] = {"count": 0, "started": time.time()}
        try:
            s = bridge.status()
            logger.info(f"PLUR session: {s.get('engram_count', '?')} engrams available")
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
            injected_ids = result.get("injected_ids", [])
            if session_id in _session_state:
                prev = _session_state[session_id].get("injected_ids", [])
                _session_state[session_id]["injected_ids"] = prev + injected_ids
            lines = ["<plur-memory>"]
            if result.get("directives"):
                lines.append(result["directives"])
            if result.get("constraints"):
                lines.append(result["constraints"])
            if result.get("consider"):
                lines.append(result["consider"])
            lines.append("</plur-memory>")
            return {"context": "\n".join(lines), "injected_ids": injected_ids}
        except Exception as e:
            logger.debug(f"PLUR inject failed: {e}")
            return None

    def post_llm_call(session_id, assistant_response, **kwargs):
        try:
            learnings = extract_learning_patterns(assistant_response or "")
            for statement in learnings:
                bridge.learn(statement, source="hermes:auto",
                             rationale="Auto-extracted from assistant self-report")
                if session_id in _session_state:
                    _session_state[session_id]["count"] += 1
        except Exception as e:
            logger.debug(f"PLUR learning extraction failed: {e}")

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
            logger.debug(f"PLUR session capture failed: {e}")
        finally:
            _session_state.pop(session_id, None)

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("on_session_end", on_session_end)

    # --- Tools ---
    TOOL_SCHEMAS = {
        "plur_learn": {
            "name": "plur_learn",
            "description": "Create a new engram — store a correction, preference, pattern, or decision",
            "parameters": {
                "type": "object",
                "properties": {
                    "statement": {"type": "string", "description": "The knowledge assertion"},
                    "scope": {"type": "string", "default": "global"},
                    "type": {"type": "string", "enum": ["behavioral", "terminological", "procedural", "architectural"], "default": "behavioral"},
                    "domain": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Classification tags"},
                    "rationale": {"type": "string", "description": "Why this knowledge matters"},
                    "visibility": {"type": "string", "enum": ["private", "public", "template"], "default": "private"},
                    "knowledge_anchors": {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "relevance": {"type": "number"}, "snippet": {"type": "string"}}}, "description": "Related file references"},
                    "dual_coding": {"type": "object", "properties": {"example": {"type": "string"}, "analogy": {"type": "string"}}, "description": "Concrete example and analogy"},
                    "abstract": {"type": "string", "description": "One-line abstract"},
                    "derived_from": {"type": "string", "description": "Source engram ID this was derived from"},
                },
                "required": ["statement"],
            },
        },
        "plur_recall": {
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
        "plur_inject": {
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
        "plur_list": {
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
        "plur_forget": {
            "name": "plur_forget",
            "description": "Retire an engram by ID or search query",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "search": {"type": "string", "description": "Forget engrams matching this search query"}, "reason": {"type": "string"}}},
        },
        "plur_feedback": {
            "name": "plur_feedback",
            "description": "Rate an engram (positive|negative|neutral) — supports single or batch mode",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "signal": {"type": "string", "enum": ["positive", "negative", "neutral"]}, "batch": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "signal": {"type": "string"}}}, "description": "Batch feedback: list of {id, signal} pairs"}}},
        },
        "plur_capture": {
            "name": "plur_capture",
            "description": "Record an episode to the timeline",
            "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]},
        },
        "plur_timeline": {
            "name": "plur_timeline",
            "description": "Query the episodic timeline",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 20}}},
        },
        "plur_status": {
            "name": "plur_status",
            "description": "Check PLUR system health",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_sync": {
            "name": "plur_sync",
            "description": "Cross-device sync via git",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_packs_list": {
            "name": "plur_packs_list",
            "description": "List installed engram packs",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_packs_install": {
            "name": "plur_packs_install",
            "description": "Install an engram pack",
            "parameters": {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]},
        },
        "plur_ingest": {
            "name": "plur_ingest",
            "description": "Extract and save engrams from content (text, logs, conversations)",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Text content to extract engrams from"},
                    "source": {"type": "string", "description": "Source identifier"},
                    "extract_only": {"type": "boolean", "default": False, "description": "If true, extract but don't save"},
                    "scope": {"type": "string"},
                    "domain": {"type": "string"},
                },
                "required": ["content"],
            },
        },
        "plur_packs_export": {
            "name": "plur_packs_export",
            "description": "Export engrams as a shareable pack",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "domain": {"type": "string"}, "scope": {"type": "string"}}, "required": ["name"]},
        },
        "plur_promote": {
            "name": "plur_promote",
            "description": "Promote an engram — increase its activation and priority",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        },
        "plur_stores_add": {
            "name": "plur_stores_add",
            "description": "Add a knowledge store path",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "scope": {"type": "string", "default": "global"}, "shared": {"type": "boolean", "default": False}, "readonly": {"type": "boolean", "default": False}}, "required": ["path"]},
        },
        "plur_stores_list": {
            "name": "plur_stores_list",
            "description": "List configured knowledge stores",
            "parameters": {"type": "object", "properties": {}},
        },
        "plur_similarity_search": {
            "name": "plur_similarity_search",
            "description": "Search engrams by cosine similarity, returning scores. Scores > 0.9 indicate duplicates, 0.7-0.9 related, < 0.7 new.",
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
        "plur_batch_decay": {
            "name": "plur_batch_decay",
            "description": "Apply ACT-R decay to all engrams. Run weekly. Returns status transitions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "context_scope": {"type": "string", "description": "Scope to skip during decay"},
                },
            },
        },
    }

    def _make_handler(tool_name: str):
        def handler(args: dict, **kwargs) -> str:
            try:
                if tool_name == "plur_learn":
                    result = bridge.learn(args["statement"], scope=args.get("scope", "global"),
                                          type=args.get("type", "behavioral"), domain=args.get("domain"),
                                          tags=args.get("tags"), rationale=args.get("rationale"),
                                          visibility=args.get("visibility"),
                                          knowledge_anchors=args.get("knowledge_anchors"),
                                          dual_coding=args.get("dual_coding"),
                                          abstract=args.get("abstract"),
                                          derived_from=args.get("derived_from"))
                elif tool_name == "plur_recall":
                    result = bridge.recall(args["query"], limit=args.get("limit", 10), fast=args.get("fast", False))
                elif tool_name == "plur_inject":
                    result = bridge.inject(args["task"], budget=args.get("budget", 2000), fast=args.get("fast", False))
                elif tool_name == "plur_list":
                    result = bridge.list_engrams(domain=args.get("domain"), type=args.get("type"),
                                                  scope=args.get("scope"), limit=args.get("limit"), meta=args.get("meta", False))
                elif tool_name == "plur_forget":
                    result = bridge.forget(id=args.get("id"), reason=args.get("reason"),
                                           search=args.get("search"))
                elif tool_name == "plur_feedback":
                    batch = args.get("batch")
                    if batch:
                        result = bridge.feedback(batch=[(item["id"], item["signal"]) for item in batch])
                    else:
                        result = bridge.feedback(args["id"], args["signal"])
                elif tool_name == "plur_capture":
                    result = bridge.capture(args["summary"])
                elif tool_name == "plur_timeline":
                    result = bridge.timeline(query=args.get("query"), limit=args.get("limit", 20))
                elif tool_name == "plur_status":
                    result = bridge.status()
                elif tool_name == "plur_sync":
                    result = bridge.sync()
                elif tool_name == "plur_ingest":
                    result = bridge.ingest(args["content"], source=args.get("source"),
                                           extract_only=args.get("extract_only", False),
                                           scope=args.get("scope"), domain=args.get("domain"))
                elif tool_name == "plur_packs_list":
                    result = bridge.packs_list()
                elif tool_name == "plur_packs_install":
                    result = bridge.packs_install(args["source"])
                elif tool_name == "plur_packs_export":
                    export_args = [args["name"]]
                    if args.get("domain"):
                        export_args.extend(["--domain", args["domain"]])
                    if args.get("scope"):
                        export_args.extend(["--scope", args["scope"]])
                    result = bridge.call("packs", ["export"] + export_args)
                elif tool_name == "plur_promote":
                    result = bridge.promote(args["id"])
                elif tool_name == "plur_stores_add":
                    result = bridge.stores_add(args["path"], scope=args.get("scope", "global"),
                                               shared=args.get("shared", False),
                                               readonly=args.get("readonly", False))
                elif tool_name == "plur_stores_list":
                    result = bridge.stores_list()
                elif tool_name == "plur_similarity_search":
                    result = bridge.similarity_search(args["query"], limit=args.get("limit", 10), scope=args.get("scope"))
                elif tool_name == "plur_batch_decay":
                    result = bridge.batch_decay(context_scope=args.get("context_scope"))
                else:
                    result = {"error": f"Unknown tool: {tool_name}"}
                return json.dumps(result)
            except Exception as e:
                return json.dumps({"error": str(e)})
        return handler

    for name, schema in TOOL_SCHEMAS.items():
        ctx.register_tool(name=name, toolset="plur", schema=schema, handler=_make_handler(name))

    # --- Meta-Engram Tools (4) ---
    from .meta_pipeline import MetaPipeline
    pipeline = MetaPipeline(bridge, plur_path=bridge._plur_path)

    META_TOOL_SCHEMAS = {
        "plur_extract_meta": {
            "name": "plur_extract_meta",
            "description": "Start meta-engram extraction — distills cross-domain principles",
            "parameters": {"type": "object", "properties": {"dry_run": {"type": "boolean", "default": False}}},
        },
        "plur_meta_submit_analysis": {
            "name": "plur_meta_submit_analysis",
            "description": "Submit analysis responses for active meta-extraction pipeline",
            "parameters": {"type": "object", "properties": {"responses": {"type": "array", "items": {"type": "string"}}}, "required": ["responses"]},
        },
        "plur_meta_engrams": {
            "name": "plur_meta_engrams",
            "description": "List meta-engrams — cross-domain principles",
            "parameters": {"type": "object", "properties": {"domain": {"type": "string"}, "min_confidence": {"type": "number"}}},
        },
        "plur_validate_meta": {
            "name": "plur_validate_meta",
            "description": "Test a meta-engram against a new domain",
            "parameters": {"type": "object", "properties": {"id": {"type": "string"}, "domain": {"type": "string"}}, "required": ["id", "domain"]},
        },
    }

    def _make_meta_handler(tool_name: str):
        def handler(args: dict, **kwargs) -> str:
            try:
                session_id = kwargs.get("session_id", "default")
                if tool_name == "plur_extract_meta":
                    result = pipeline.start_extraction(session_id, dry_run=args.get("dry_run", False))
                elif tool_name == "plur_meta_submit_analysis":
                    result = pipeline.submit_analysis(session_id, args["responses"])
                elif tool_name == "plur_meta_engrams":
                    result = bridge.list_engrams(meta=True, domain=args.get("domain"))
                elif tool_name == "plur_validate_meta":
                    result = {
                        "status": "prompts_ready",
                        "prompts": [
                            f"Test this meta-engram in the domain '{args['domain']}':\n"
                            f"ID: {args['id']}\n\n"
                            f"Does the principle hold? Return JSON: "
                            f"{{\"holds\": true/false, \"evidence\": \"...\", \"confidence\": <0-1>}}"
                        ],
                    }
                else:
                    result = {"error": f"Unknown meta tool: {tool_name}"}
                return json.dumps(result)
            except Exception as e:
                return json.dumps({"error": str(e)})
        return handler

    for name, schema in META_TOOL_SCHEMAS.items():
        ctx.register_tool(name=name, toolset="plur-meta", schema=schema, handler=_make_meta_handler(name))

    total_tools = len(TOOL_SCHEMAS) + len(META_TOOL_SCHEMAS)
    logger.info(f"PLUR registered: 4 hooks + {total_tools} tools (incl. meta)")
