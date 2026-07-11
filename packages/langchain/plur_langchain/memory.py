"""PlurMemory — BaseMemory adapter for legacy ConversationChain."""
from __future__ import annotations

from typing import Any

from langchain_core.memory import BaseMemory  # type: ignore[import]

from ._utils import inject_to_text, make_bridge
from .learner import extract_learning_patterns


class PlurMemory(BaseMemory):
    """Persistent semantic memory via PLUR for legacy LangChain ConversationChain.

    On load_memory_variables: injects relevant engrams as a context string.
    On save_context: scans the AI response for self-correction patterns
    and persists them as new PLUR engrams — same pattern as plur-hermes.

    Usage::

        from langchain.chains import ConversationChain
        from plur_langchain import PlurMemory

        chain = ConversationChain(llm=llm, memory=PlurMemory())
    """

    memory_key: str = "history"
    input_key: str = "input"
    output_key: str = "response"
    inject_budget: int = 1500
    auto_learn: bool = True
    plur_path: str | None = None

    class Config:
        arbitrary_types_allowed = True

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        object.__setattr__(self, "_bridge", make_bridge(self.plur_path))

    @property
    def memory_variables(self) -> list[str]:
        return [self.memory_key]

    def load_memory_variables(self, inputs: dict[str, Any]) -> dict[str, Any]:
        task = inputs.get(self.input_key, "") or " ".join(str(v) for v in inputs.values())
        context = inject_to_text(self._bridge, str(task), budget=self.inject_budget)
        if not context:
            return {self.memory_key: ""}
        return {self.memory_key: f"[Relevant memory]\n{context}"}

    def save_context(self, inputs: dict[str, Any], outputs: dict[str, Any]) -> None:
        if not self.auto_learn:
            return
        response = outputs.get(self.output_key, "") or " ".join(str(v) for v in outputs.values())
        if not response:
            return
        learnings = extract_learning_patterns(str(response))
        for statement in learnings:
            try:
                self._bridge.learn(
                    statement,
                    source="langchain:PlurMemory",
                    rationale="Auto-extracted from LangChain chain output",
                )
            except Exception:
                pass

    def clear(self) -> None:
        pass
