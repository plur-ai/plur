# PLUR Memory

Memory you own for Claude Code. Corrections, preferences and conventions carry over between sessions and come back when they are relevant. Notes are plain YAML files on your disk, so you can read, edit, copy or delete them yourself.

Open source under Apache-2.0: [github.com/plur-ai/plur](https://github.com/plur-ai/plur).

## What it adds

- The PLUR MCP server, with tools to save, search, rate and retire notes.
- A `plur-memory` skill that explains those tools to Claude.
- Hooks that make memory automatic, described below.

## Using it

The first time PLUR runs in a folder, it asks whether memory should be on there, and loads and saves nothing until you answer. Your answer is recorded by a one-line command. If the `plur` command is not installed, Claude runs the same command through `npx -y @plur-ai/cli`, at the same version as the server.

Once a folder is on, relevant notes reach Claude by themselves. To be sure something is saved to PLUR, name it, because Claude also has its own memory: "save to PLUR that this project uses pnpm".

Notes about a project stay with that project, named after its repository. Preferences you want everywhere, such as "across all my projects, end commit messages with [gs]", follow you into every project where PLUR is on.

The server is a local program, so it runs in Claude Code and in Cowork sessions on your computer. It does not run in claude.ai chat.

## Automatic memory

With the `automatic_memory` setting on, which is the default, these hooks run in folders where you turned PLUR on:

| When | What happens |
|---|---|
| You send a prompt | Saved notes relevant to the prompt are added to the conversation. From time to time this also adds a reminder for Claude to save what it learned |
| The conversation is compacted or resumed | The notes are added again, or the folder question is asked again |
| The session ends | The session's memory record is closed |
| Claude Code starts | The PLUR command-line package is fetched from npm if it is not cached yet, in the background |

Turn it off in `/config`, under this plugin. PLUR then acts only when its tools are called, and you can turn it back on at any time. Removing the plugin removes the hooks, and your notes stay in `~/.plur/`.

If `plur init` has put PLUR's hooks in the Claude Code settings used for a project, those hooks stay in charge there and this plugin's hooks do nothing, so nothing is added twice. If those hooks are removed later, this plugin's hooks take over. `plur init` is also how to use the same memory in Cursor, Codex and other tools.

## What it runs

The server and hooks start from exact versions on npm, `npx -y @plur-ai/mcp@<version>` and `npx -y @plur-ai/cli@<version>`. The versions are pinned in this plugin and change only with a new plugin release. Node.js 22 or newer is required.

## Privacy

**Where your notes live.** In `~/.plur/` on your computer. Set `PLUR_PATH` to use another folder. Delete the folder to delete everything.

**What leaves your computer by default.**

- A version check to the npm registry (`registry.npmjs.org`), which sends the package name and no memory content, and the package downloads described above.
- On first use of semantic search, a one-time download of the embedding model from Hugging Face. Set `PLUR_MODEL_DOWNLOAD=off` to prevent it; keyword search keeps working.

**What is off unless you turn it on.**

- Usage reporting. Set `PLUR_TELEMETRY=on` to send daily operation counts, the version and your operating system to `plur.ai`.
- Remote stores. Notes are sent to a server only if you add one.
- Language model features. If `OPENAI_API_KEY` or `OPENROUTER_API_KEY` is set in the server's environment, a few operations, such as duplicate checks and contradiction scans, send the text of the notes involved to that provider.

The full policy, including retention and contact details, is at [plur.ai/privacy](https://plur.ai/privacy).

## Support

Open an issue at [github.com/plur-ai/plur/issues](https://github.com/plur-ai/plur/issues). Documentation is at [docs.plur.ai](https://docs.plur.ai).
