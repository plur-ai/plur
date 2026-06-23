"""llama.cpp + PLUR: prepend recalled memory to a local completion.

Same idea as the LangChain example, but for a fully local stack: recall the
engrams relevant to the prompt and splice them into the context window before
calling the model. Local model + local memory = no data leaves the machine.

Run:
    pip install plur-ai llama-cpp-python
    npm install -g @plur-ai/cli   # or rely on the npx fallback
    python llamacpp_memory.py /path/to/model.gguf
"""
from __future__ import annotations

import sys

from plur_ai import Plur

from llama_cpp import Llama  # type: ignore


def build_prompt(plur: Plur, user_msg: str) -> str:
    """Prepend the most relevant engrams as a memory preamble."""
    memory = "\n".join(f"- {hit['statement']}" for hit in plur.recall(user_msg, limit=5))
    preamble = f"Known facts and preferences:\n{memory}\n\n" if memory else ""
    return f"{preamble}User: {user_msg}\nAssistant:"


def main(model_path: str) -> None:
    plur = Plur()
    plur.learn("Always answer in metric units", type="behavioral", domain="style")

    llm = Llama(model_path=model_path, n_ctx=4096, verbose=False)
    prompt = build_prompt(plur, "How far is a marathon?")
    out = llm(prompt, max_tokens=128, stop=["User:"])
    print(out["choices"][0]["text"].strip())


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python llamacpp_memory.py /path/to/model.gguf")
    main(sys.argv[1])
