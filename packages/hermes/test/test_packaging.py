"""Packaging assertions — both hermes entry point groups must be registered.

These tests verify what a wheel-based install exposes, not just what the source
says. They run against the editable install that CI creates with `pip install -e`
(which also registers entry points), so they catch a missing declaration in
pyproject.toml before a wheel is ever built.

A missing hermes_agent.memory_providers entry is the regression from 0.19.0–0.19.2:
memory_provider.py existed but was never reachable via `memory.provider: plur`.
"""
import importlib.metadata


def test_plugins_entry_point_present():
    eps = importlib.metadata.entry_points(group="hermes_agent.plugins")
    names = [ep.name for ep in eps]
    assert "plur" in names, (
        f"hermes_agent.plugins group missing 'plur'; found: {names}"
    )


def test_memory_providers_entry_point_present():
    eps = importlib.metadata.entry_points(group="hermes_agent.memory_providers")
    names = [ep.name for ep in eps]
    assert "plur" in names, (
        f"hermes_agent.memory_providers group missing 'plur'; found: {names}. "
        "'memory.provider: plur' in config.yaml will silently do nothing. "
        "Check [project.entry-points] in pyproject.toml."
    )


def test_memory_providers_entry_point_loads():
    eps = importlib.metadata.entry_points(group="hermes_agent.memory_providers")
    ep = next((ep for ep in eps if ep.name == "plur"), None)
    assert ep is not None, "plur entry point not found in hermes_agent.memory_providers"
    cls = ep.load()
    assert cls is not None, "Entry point loaded None"
    assert hasattr(cls, "prefetch"), (
        f"Loaded class {cls!r} missing 'prefetch' — does not look like PlurMemoryProvider"
    )
