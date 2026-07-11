"""Tests for PlurChatMessageHistory."""
from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage


def _make_history(**kwargs):
    with patch("plur_langchain._utils.make_bridge") as mock_make:
        mock_bridge = MagicMock()
        mock_make.return_value = mock_bridge
        from plur_langchain.chat_history import PlurChatMessageHistory
        history = PlurChatMessageHistory(**kwargs)
        history._bridge = mock_bridge
    return history, mock_bridge


def test_messages_empty_initially():
    history, bridge = _make_history()
    bridge.inject.return_value = {"directives": "", "constraints": "", "consider": ""}
    assert history.messages == []


def test_messages_prepends_system_message_with_context():
    history, bridge = _make_history()
    bridge.inject.return_value = {"directives": "Deploy blue-green", "constraints": "", "consider": ""}
    history.add_message(HumanMessage(content="how do I deploy?"))
    msgs = history.messages
    assert isinstance(msgs[0], SystemMessage)
    assert "Deploy blue-green" in msgs[0].content


def test_add_human_message_sets_last_input():
    history, bridge = _make_history()
    bridge.inject.return_value = {"directives": "", "constraints": "", "consider": ""}
    history.add_message(HumanMessage(content="tell me about deploy"))
    assert history._last_human_input == "tell me about deploy"


def test_ai_message_triggers_learning():
    history, bridge = _make_history()
    history.add_message(AIMessage(content="I was wrong. The right approach is blue-green."))
    assert bridge.learn.called


def test_ai_message_no_learning_when_disabled():
    history, bridge = _make_history(auto_learn=False)
    history.add_message(AIMessage(content="I was wrong about that."))
    bridge.learn.assert_not_called()


def test_clear_empties_messages():
    history, bridge = _make_history()
    bridge.inject.return_value = {"directives": "", "constraints": "", "consider": ""}
    history.add_message(HumanMessage(content="hello"))
    history.clear()
    assert history._messages == []
    assert history._last_human_input == ""
