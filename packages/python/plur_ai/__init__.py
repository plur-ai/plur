"""plur-ai — Local-first shared memory for AI agents, as a Python SDK.

A thin, Pythonic wrapper over the `@plur-ai/cli`. Use it to give any Python
agent stack (LangChain, llama.cpp, custom loops) the same persistent memory the
MCP server gives Claude Code, Cursor, and OpenClaw.

    from plur_ai import Plur

    plur = Plur()
    plur.learn("api-service uses REST not GraphQL", type="architectural")
    for hit in plur.recall("which API style"):
        print(hit["statement"])
"""
from __future__ import annotations

from .bridge import PlurError, PlurNotInstalledError
from .client import Plur

__version__ = "0.10.0"
__all__ = ["Plur", "PlurError", "PlurNotInstalledError", "__version__"]
