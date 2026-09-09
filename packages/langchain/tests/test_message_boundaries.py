"""Valid multimodal input and visible, source-free dependency failures."""
from unittest.mock import MagicMock, patch
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from plur_langchain import PlurChatMessageHistory, PlurMemory


def history_with(bridge):
    with patch("plur_langchain.chat_history.make_bridge", return_value=bridge):
        return PlurChatMessageHistory()


def memory_with(bridge):
    with patch("plur_langchain.memory.make_bridge", return_value=bridge):
        return PlurMemory()


def blocks(text):
    return [{"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": "https://example.invalid/private-image"}}]


def test_multimodal_human_input_recalls_using_only_text():
    bridge = MagicMock()
    bridge.inject.return_value = {"directives": "Remember deploy checks"}
    history = history_with(bridge)
    message = HumanMessage(content=blocks("deploy the service"))
    history.add_message(message)
    assert "Remember deploy checks" in history.messages[0].content
    bridge.inject.assert_called_once_with("deploy the service", budget=1500)
    assert history.messages[-1] is message


def test_multimodal_ai_correction_is_learned_without_nontext_blocks():
    bridge = MagicMock()
    history = history_with(bridge)
    text = "I was wrong about the deployment target."
    history.add_message(AIMessage(content=blocks(text)))
    bridge.learn.assert_called_once_with(
        text, source="langchain:PlurChatMessageHistory",
        rationale="Auto-extracted from LangChain AI message",
    )


def test_legacy_adapter_accepts_message_objects_and_content_blocks():
    bridge = MagicMock()
    bridge.inject.return_value = {"directives": "Keep deployment checks"}
    memory = memory_with(bridge)
    memory.load_memory_variables({"input": HumanMessage(content=blocks("deploy"))})
    bridge.inject.assert_called_once_with("deploy", budget=1500)
    text = "I was wrong about the deployment target."
    memory.save_context({}, {"response": blocks(text)})
    assert bridge.learn.call_args.args[0] == text


def test_failed_recall_raises_without_leaking_error_details_and_recovers():
    bridge = MagicMock()
    bridge.inject.side_effect = [RuntimeError("synthetic-private-detail"), {"directives": "Recovered"}]
    memory = memory_with(bridge)
    with pytest.raises(RuntimeError, match="PLUR memory recall failed") as failure:
        memory.load_memory_variables({"input": "deploy"})
    assert "synthetic-private-detail" not in str(failure.value)
    assert "Recovered" in memory.load_memory_variables({"input": "deploy"})["history"]


@pytest.mark.parametrize("factory", [history_with, memory_with])
def test_failed_learning_raises_without_claiming_persistence(factory):
    bridge = MagicMock()
    bridge.learn.side_effect = RuntimeError("synthetic-private-detail")
    adapter = factory(bridge)
    text = "I was wrong about the deployment target."
    with pytest.raises(RuntimeError, match="PLUR memory learning failed") as failure:
        if isinstance(adapter, PlurMemory):
            adapter.save_context({}, {"response": text})
        else:
            adapter.add_message(AIMessage(content=text))
    assert "synthetic-private-detail" not in str(failure.value)


@pytest.mark.parametrize("response", [None, [], {"directives": ["invalid"]}])
def test_malformed_recall_responses_are_visible_failures(response):
    bridge = MagicMock()
    bridge.inject.return_value = response
    with pytest.raises(RuntimeError, match="PLUR memory recall failed"):
        memory_with(bridge).load_memory_variables({"input": "deploy"})


def test_failed_batch_preserves_history_and_retry_does_not_duplicate_prefix():
    bridge = MagicMock()
    history = history_with(bridge)
    prior = HumanMessage(content="previous task")
    history.add_message(prior)
    batch = [HumanMessage(content="new task"),
             AIMessage(content="I was wrong about the deployment target.")]
    bridge.learn.side_effect = RuntimeError("storage unavailable")
    with pytest.raises(RuntimeError):
        history.add_messages(batch)
    assert history._messages == [prior]
    assert history._last_human_input == "previous task"
    bridge.learn.side_effect = None
    history.add_messages(batch)
    assert history._messages == [prior, *batch]
    assert history._last_human_input == "new task"


def test_concurrent_recall_uses_a_coherent_history_snapshot():
    bridge = MagicMock()
    history = history_with(bridge)
    prior = HumanMessage(content="previous task")
    history.add_message(prior)
    started, release = Event(), Event()

    def recall(task, **kwargs):
        assert task == "previous task"
        started.set()
        assert release.wait(5)
        return {"directives": "Context for previous task"}

    bridge.inject.side_effect = recall
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(lambda: history.messages)
        try:
            assert started.wait(5)
            history.add_message(HumanMessage(content="concurrent new task"))
        finally:
            release.set()
        snapshot = result.result(timeout=5)
    assert [m.content for m in snapshot] == ["[Relevant memory]\nContext for previous task", "previous task"]
    assert history._last_human_input == "concurrent new task"


def test_pending_ai_learning_does_not_overwrite_a_new_human_turn():
    bridge = MagicMock()
    history = history_with(bridge)
    started, release = Event(), Event()

    def learn(*args, **kwargs):
        started.set()
        assert release.wait(5)

    bridge.learn.side_effect = learn
    ai = AIMessage(content="I was wrong about the deployment target.")
    human = HumanMessage(content="concurrent new task")
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(history.add_message, ai)
        try:
            assert started.wait(5)
            history.add_message(human)
        finally:
            release.set()
        result.result(timeout=5)
    assert history._messages == [human, ai]
    assert history._last_human_input == "concurrent new task"
