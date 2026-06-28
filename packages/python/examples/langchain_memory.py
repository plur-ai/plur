"""LangChain + PLUR: inject persistent memory into a prompt.

The pattern: before the model answers, ask PLUR for the engrams relevant to the
user's task and prepend them as a system message. Nothing LangChain-specific
lives in PLUR — `plur.inject()` returns plain strings you drop into any prompt.

Run:
    pip install plur-ai langchain-core langchain-openai
    npm install -g @plur-ai/cli   # or rely on the npx fallback
    python langchain_memory.py
"""
from __future__ import annotations

from plur_ai import Plur

# langchain is optional — import lazily so the file reads without it installed.
from langchain_core.messages import HumanMessage, SystemMessage  # type: ignore
from langchain_openai import ChatOpenAI  # type: ignore


def plur_system_message(plur: Plur, task: str) -> SystemMessage:
    """Build a system message from the engrams PLUR deems relevant to `task`."""
    ctx = plur.inject(task, budget=1500)
    sections = [s for s in (ctx["directives"], ctx["constraints"], ctx["consider"]) if s.strip()]
    body = "\n".join(sections) or "(no relevant memory yet)"
    return SystemMessage(content=f"Relevant memory for this task:\n{body}")


def main() -> None:
    plur = Plur()
    # Seed a couple of facts (normally these accrue over time / via agents).
    plur.learn("This project deploys with blue-green; never restart prod in place",
               type="architectural", domain="ops/deploy")
    plur.learn("House style: prefer explicit code over clever one-liners",
               type="behavioral", domain="dev/style")

    task = "Write the deploy step for the release runbook"
    llm = ChatOpenAI(model="gpt-4o-mini")
    response = llm.invoke([plur_system_message(plur, task), HumanMessage(content=task)])
    print(response.content)


if __name__ == "__main__":
    main()
