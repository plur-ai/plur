"""Tests for PlurMemory."""
from unittest.mock import MagicMock, patch

import pytest


def _make_memory(**kwargs):
    with patch("plur_langchain.memory.make_bridge") as mock_make:
        mock_bridge = MagicMock()
        mock_make.return_value = mock_bridge
        from plur_langchain.memory import PlurMemory
        memory = PlurMemory(**kwargs)
    return memory, mock_bridge


def test_memory_variables():
    memory, _ = _make_memory()
    assert memory.memory_variables == ["history"]


def test_load_memory_variables_injects_context():
    memory, bridge = _make_memory()
    bridge.inject.return_value = {
        "directives": "Use REST not GraphQL",
        "constraints": "",
        "consider": "",
    }
    result = memory.load_memory_variables({"input": "write the deploy step"})
    assert "REST not GraphQL" in result["history"]
    bridge.inject.assert_called_once()


def test_load_memory_variables_empty_when_no_engrams():
    memory, bridge = _make_memory()
    bridge.inject.return_value = {"directives": "", "constraints": "", "consider": ""}
    result = memory.load_memory_variables({"input": "hello"})
    assert result["history"] == ""


def test_save_context_learns_from_correction():
    memory, bridge = _make_memory()
    outputs = {"response": "I was wrong. The correct way is to use PUT not POST."}
    memory.save_context({"input": "how do I update?"}, outputs)
    assert bridge.learn.called
    assert bridge.learn.call_args.kwargs["claim_class"] == "inferred"


def test_save_context_no_learn_when_disabled():
    memory, bridge = _make_memory(auto_learn=False)
    memory.save_context({"input": "x"}, {"response": "I was wrong about this."})
    bridge.learn.assert_not_called()


def test_clear_does_not_raise():
    memory, _ = _make_memory()
    memory.clear()


def test_save_context_old_client_without_claim_class_fails_visibly():
    memory, bridge = _make_memory()
    bridge.learn.side_effect = TypeError("learn() got an unexpected keyword argument 'claim_class'")
    with pytest.raises(TypeError, match="claim_class"):
        memory.save_context({"input": "x"}, {"response": "I was wrong. The correct way is to use PUT not POST."})
    assert bridge.learn.call_count == 1


def test_save_context_still_swallows_other_learn_errors():
    memory, bridge = _make_memory()
    bridge.learn.side_effect = RuntimeError("cli failed")
    memory.save_context({"input": "x"}, {"response": "I was wrong. The correct way is to use PUT not POST."})


def test_save_context_still_swallows_unrelated_type_errors():
    memory, bridge = _make_memory()
    bridge.learn.side_effect = TypeError("unsupported operand type(s) for +: 'int' and 'str'")
    memory.save_context({"input": "x"}, {"response": "I was wrong. The correct way is to use PUT not POST."})
    assert bridge.learn.call_count == 1
