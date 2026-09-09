"""Security and API contracts for the supported LangChain dependency line."""
import json
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.load import dumps, loads
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableLambda
from langchain_core.runnables.history import RunnableWithMessageHistory

from plur_langchain import PlurChatMessageHistory, PlurMemory


@pytest.mark.parametrize("field", ["additional_kwargs", "response_metadata"])
@pytest.mark.parametrize("kind", ["secret", "constructor"])
def test_message_serialization_preserves_untrusted_markers_as_data(monkeypatch, field, kind):
    monkeypatch.setenv("PLUR_TEST_SERIALIZATION_CANARY", "synthetic-canary-value")
    marker = {"lc": 1, "type": "secret", "id": ["PLUR_TEST_SERIALIZATION_CANARY"]}
    constructor = {"lc": 1, "type": "constructor",
                   "id": ["untrusted", "NeverConstruct"], "kwargs": {}}
    payload = {"nested": [marker if kind == "secret" else constructor]}
    message = AIMessage(content="ordinary response", **{field: payload})
    # Trusting our own serialization must not turn message metadata into code
    # or secret lookups, even when a caller explicitly enables env secrets.
    restored = loads(dumps(message), secrets_from_env=True)
    assert isinstance(restored, AIMessage)
    assert getattr(restored, field) == payload
    assert "synthetic-canary-value" not in json.dumps(getattr(restored, field))


def test_runnable_history_preserves_messages_and_legacy_adapter_contract():
    bridge = MagicMock()
    bridge.inject.return_value = {"directives": "", "constraints": "", "consider": ""}
    with patch("plur_langchain.chat_history.make_bridge", return_value=bridge):
        history = PlurChatMessageHistory(session_id="test-session", auto_learn=False)
    chain = RunnableWithMessageHistory(
        RunnableLambda(lambda inputs: AIMessage(content="reply to " + inputs["input"])),
        lambda session_id: history,
        input_messages_key="input", history_messages_key="chat_history",
    )
    config = {"configurable": {"session_id": "test-session"}}
    assert chain.invoke({"input": "first"}, config=config).content == "reply to first"
    assert chain.invoke({"input": "second"}, config=config).content == "reply to second"
    assert [m.content for m in history.messages] == [
        "first", "reply to first", "second", "reply to second",
    ]
    assert isinstance(history.messages[0], HumanMessage)
    with patch("plur_langchain.memory.make_bridge", return_value=bridge):
        memory = PlurMemory(memory_key="context")
    assert memory.memory_variables == ["context"]
    assert memory.load_memory_variables({"input": "first"}) == {"context": ""}
