"""PlurChatMessageHistory — BaseChatMessageHistory for modern LCEL."""
from __future__ import annotations

from typing import Any, List, Sequence
from threading import RLock

from langchain_core.chat_history import BaseChatMessageHistory  # type: ignore[import]
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage  # type: ignore[import]

from ._utils import inject_to_text, learn_from_text, make_bridge, message_text


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
        self._lock = RLock()
        self._messages: list[BaseMessage] = []
        self._last_human_input: str = ""

    @property
    def messages(self) -> list[BaseMessage]:
        with self._lock:
            last_input = self._last_human_input
            snapshot = list(self._messages)
        if not last_input:
            return snapshot
        context = inject_to_text(self._bridge, last_input, budget=self.inject_budget)
        if not context:
            return snapshot
        system_msg = SystemMessage(content=f"[Relevant memory]\n{context}")
        return [system_msg] + snapshot

    def add_message(self, message: BaseMessage) -> None:
        self.add_messages([message])

    def add_messages(self, messages: Sequence[BaseMessage]) -> None:
        from langchain_core.messages import HumanMessage  # type: ignore[import]
        batch = list(messages)
        last_input = None
        learning_texts = []
        for message in batch:
            if not isinstance(message, BaseMessage):
                raise TypeError("Chat history requires BaseMessage instances")
            if isinstance(message, HumanMessage):
                last_input = message_text(message)
            elif isinstance(message, AIMessage) and self.auto_learn:
                learning_texts.append(message_text(message))
        # Complete fallible work before committing transcript state. Successful
        # learn calls are individually durable; PLUR deduplicates them on retry.
        for text in learning_texts:
            self._learn_from_ai(text)
        with self._lock:
            self._messages.extend(batch)
            if last_input is not None:
                self._last_human_input = last_input

    def _learn_from_ai(self, text: str) -> None:
        learn_from_text(
            self._bridge, text, source="langchain:PlurChatMessageHistory",
            rationale="Auto-extracted from LangChain AI message",
        )

    def clear(self) -> None:
        with self._lock:
            self._messages.clear()
            self._last_human_input = ""
