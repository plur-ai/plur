# plur-langchain

LangChain memory adapter for [PLUR](https://plur.ai) — plug persistent, local-first engram memory into any LangChain chain.

## Install

```bash
pip install "plur-langchain @ git+https://github.com/plur-ai/plur.git#subdirectory=packages/langchain"
```

> **Note:** `plur-langchain` is not yet on PyPI — use the git install above until [#915](https://github.com/plur-ai/plur/issues/915) is resolved.

Requires Node.js (for the `@plur-ai/cli` runtime that PLUR shells out to) and `@plur-ai/mcp` installed.

## Usage

### LCEL / RunnableWithMessageHistory (recommended)

```python
from langchain_core.runnables.history import RunnableWithMessageHistory
from plur_langchain import PlurChatMessageHistory

chain_with_history = RunnableWithMessageHistory(
    chain,
    lambda session_id: PlurChatMessageHistory(session_id=session_id),
    input_messages_key="input",
    history_messages_key="chat_history",
)
```

Each turn, PLUR injects the most relevant engrams as a leading `SystemMessage`. When the AI self-corrects, that correction is persisted as a new engram.

### Legacy ConversationChain

```python
from langchain.chains import ConversationChain
from plur_langchain import PlurMemory

chain = ConversationChain(llm=llm, memory=PlurMemory())
```

> Requires Python 3.10+ and patched LangChain Core 0.3 (`>=0.3.85,<0.4`).
> `PlurMemory` retains the legacy `BaseMemory` interface, deprecated in Core 0.3
> and removed in 1.0. Use `PlurChatMessageHistory` for LCEL. The older Core 0.2
> dependency is no longer supported because it lacks serialization security fixes.

## How it works

PLUR stores learned facts (engrams) locally in `~/.plur/`. On every chain invocation, relevant engrams are retrieved via semantic search and injected as context. Self-correction patterns in AI responses are captured and persisted — so the chain learns from its own mistakes.

Storage and retrieval default to local operation. Configured PLUR remotes,
model providers, or LangChain tracing can send data to their configured services.

Text blocks in multimodal messages participate in recall and learning; image
URLs and other non-text blocks are not sent to the memory bridge. Failed reads,
malformed recall responses and failed learning raise `PlurMemoryError` with a
source-free message. Callers can handle that failure explicitly; an unavailable
store is not reported as empty memory or a successful write.

## Links

- [PLUR docs](https://plur.ai)
- [npm: @plur-ai/mcp](https://www.npmjs.com/package/@plur-ai/mcp)
- [GitHub](https://github.com/plur-ai/plur)
