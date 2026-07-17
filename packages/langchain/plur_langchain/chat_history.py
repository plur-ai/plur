"""PlurChatMessageHistory — BaseChatMessageHistory for modern LCEL."""
from __future__ import annotations

from typing import Any, List, Sequence

from langchain_core.chat_history import BaseChatMessageHistory  # type: ignore[import]
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage  # type: ignore[import]

from ._utils import inject_to_text, make_bridge
from .learner import extract_learning_patterns


class PlurChatMessageHistory(BaseChatMessageHistory):
    """PLUR-backed chat message history for LCEL / RunnableWithMessageHistory.

    Each call to messages injects the engrams most relevant to the last human
    turn as a leading SystemMessage. AI messages are scanned for self-correction
    patterns; matches are persisted as new PLUR engrams.

    Usage::

        from langchain_core.runnables.history import RunnableWithMessageHistory
        from plur_langchain import PlurChatMessageHistory

        chain_with_history = RunnableWithMessageHistory(
            chain,
            lambda session_id: PlurChatMessageHistory(session_id=session_id),
            input_messages_key="input",
            history_messages_key="chat_history",
        )
    """

    def __init__(
        self,
        session_id: str = "default",
        inject_budget: int = 1500,
        auto_learn: bool = True,
        plur_path: str | None = None,
    ) -> None:
        self.session_id = session_id
        self.inject_budget = inject_budget
        self.auto_learn = auto_learn
        self._bridge = make_bridge(plur_path)
        self._messages: list[BaseMessage] = []
        self._last_human_input: str = ""

    @property
    def messages(self) -> list[BaseMessage]:
        if not self._last_human_input:
            return list(self._messages)
        context = inject_to_text(self._bridge, self._last_human_input, budget=self.inject_budget)
        if not context:
            return list(self._messages)
        system_msg = SystemMessage(content=f"[Relevant memory]\n{context}")
        return [system_msg] + list(self._messages)

    def add_message(self, message: BaseMessage) -> None:
        from langchain_core.messages import HumanMessage  # type: ignore[import]
        if isinstance(message, HumanMessage):
            self._last_human_input = message.content or ""
        elif isinstance(message, AIMessage) and self.auto_learn:
            self._learn_from_ai(str(message.content or ""))
        self._messages.append(message)

    def add_messages(self, messages: Sequence[BaseMessage]) -> None:
        for message in messages:
            self.add_message(message)

    def _learn_from_ai(self, text: str) -> None:
        learnings = extract_learning_patterns(text)
        for statement in learnings:
            try:
                self._bridge.learn(
                    statement,
                    source="langchain:PlurChatMessageHistory",
                    rationale="Auto-extracted from LangChain AI message",
                )
            except Exception:
                pass

    def clear(self) -> None:
        self._messages.clear()
        self._last_human_input = ""
