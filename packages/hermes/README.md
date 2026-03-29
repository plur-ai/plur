# plur-hermes

Persistent memory plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Learn from corrections, recall past insights, extract cross-domain principles.

## Install

```bash
npm install -g @plur-ai/cli
pip install plur-hermes
```

The plugin is auto-discovered by Hermes on startup.

## What it does

- **Auto-injection**: Relevant engrams injected into every conversation turn
- **Auto-learning**: Captures corrections and insights from the `🧠 I learned:` protocol
- **16 tools**: learn, recall, inject, list, forget, feedback, capture, timeline, status, sync, packs, meta-extraction
- **4 hooks**: pre_llm_call, post_llm_call, on_session_start, on_session_end

## License

Apache-2.0
