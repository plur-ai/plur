# plur-langchain

LangChain memory adapter for [PLUR](https://plur.ai) — plug persistent, local-first engram memory into any LangChain chain.

## Install

```bash
pip install plur-langchain
```

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

> **Note:** `PlurMemory` uses `BaseMemory`, which was removed in `langchain-core>=0.3`. Use `PlurChatMessageHistory` for modern LangChain.

## How it works

PLUR stores learned facts (engrams) locally in `~/.plur/`. On every chain invocation, relevant engrams are retrieved via semantic search and injected as context. Self-correction patterns in AI responses are captured and persisted — so the chain learns from its own mistakes.

Your data never leaves your machine.

## Links

- [PLUR docs](https://plur.ai)
- [npm: @plur-ai/mcp](https://www.npmjs.com/package/@plur-ai/mcp)
- [GitHub](https://github.com/plur-ai/plur)
