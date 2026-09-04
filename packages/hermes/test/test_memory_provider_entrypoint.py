"""The memory-provider entry point must resolve through Hermes' loader.

0.19.0-0.19.2 shipped no `hermes_agent.memory_providers` entry point at all.
0.19.3 shipped one that pointed at the factory function — and still loaded
nothing, because Hermes' `_load_provider_from_entry_point` walks:

    isinstance(loaded, MemoryProvider)              -> a function is not one
    issubclass(loaded, MemoryProvider)              -> not a type
    hasattr(loaded, "register")                     -> a function has no .register
    callable(loaded) -> isinstance(loaded(), MemoryProvider)

and `PlurMemoryProvider` deliberately does NOT subclass the ABC — subclassing
would make hermes_agent a hard runtime dependency and cost the zero-dependency
guarantee. Every branch missed, the loader fell through to `loaded(collector)`
(passing the collector in as `bridge`) and returned `collector.provider` = None.

The `register` branch is the one with no type check: it calls
`collector.register_memory_provider(provider)`, which just assigns. Targeting
the PACKAGE hits it, because `plur_hermes.register()` already exists.

So this suite pins the two properties the loader actually depends on:
the entry point resolves to an object exposing `register`, and calling it
registers a provider. A future edit that "tidies" the target back to the
factory breaks discovery silently — no error, just a provider that never loads.
"""
from importlib.metadata import entry_points

GROUP = "hermes_agent.memory_providers"


def _plur_ep():
    eps = [e for e in entry_points().select(group=GROUP) if e.name == "plur"]
    assert eps, f"no '{GROUP}' entry point named 'plur' — Hermes cannot discover the provider"
    return eps[0]


def test_entry_point_is_declared():
    assert _plur_ep().value == "plur_hermes"


def test_target_exposes_register():
    """The only loader branch that accepts a non-subclass provider."""
    loaded = _plur_ep().load()
    assert hasattr(loaded, "register"), (
        "entry point target has no .register — Hermes' loader will fall through "
        "every branch and return None (this is the 0.19.3 bug)"
    )


def test_register_registers_a_provider():
    """Mimics Hermes' _ProviderCollector: register_memory_provider() just assigns."""
    class Collector:
        def __init__(self):
            self.provider = None

        def register_memory_provider(self, provider):
            self.provider = provider

        def __getattr__(self, _name):        # tolerate other register_* calls
            return lambda *a, **k: None

    c = Collector()
    _plur_ep().load().register(c)
    assert c.provider is not None, "register() did not register a memory provider"
    assert c.provider.name == "plur"
    assert len(c.provider.get_tool_schemas()) > 0
