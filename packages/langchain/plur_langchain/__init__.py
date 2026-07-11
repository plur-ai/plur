"""plur-langchain — LangChain memory adapter for PLUR.

Drop-in persistent memory for LangChain agents and chains.
PLUR is semantic memory, not a transcript buffer: on each turn it injects
the engrams most relevant to the user's current task, and scans the AI
response for self-correction patterns to persist as new engrams.

    # Legacy ConversationChain
    from plur_langchain import PlurMemory
    memory = PlurMemory()

    # Modern LCEL / RunnableWithMessageHistory
    from plur_langchain import PlurChatMessageHistory
    history = PlurChatMessageHistory(session_id="my-session")
"""
from __future__ import annotations

from .chat_history import PlurChatMessageHistory
from .memory import PlurMemory

__version__ = "0.10.0"
__all__ = ["PlurMemory", "PlurChatMessageHistory", "__version__"]
