# PLUR Memory

Local memory you own, for Claude Code. Ask Claude to remember a correction, a preference or a convention, and find it again in a later session. Notes are plain YAML files on your disk, so you can read, edit, copy or delete them yourself.

Open source under Apache-2.0: [github.com/plur-ai/plur](https://github.com/plur-ai/plur).

## What it adds

- The PLUR MCP server, with tools to save, search, rate and retire notes.
- A `plur-memory` skill that explains those tools to Claude.

This plugin installs no hooks. Claude saves or recalls a note only when a tool is called, and you approve tool calls the way you normally do.

## Using it

Name PLUR when you ask, because Claude also has its own memory. Try "save to PLUR that this project uses pnpm", then in a new session "what does PLUR have on this project's package manager?".

The first time PLUR is used in a folder, it asks whether memory should be on there, and saves nothing until you answer. Your answer is recorded by a one-line command. If the `plur` command is not installed, Claude runs the same command through `npx -y @plur-ai/cli`, at the same version as the server.

The server is a local program, so it runs in Claude Code and in Cowork sessions on your computer. It does not run in claude.ai chat.

## What it runs

The plugin starts the server with an exact version from npm, `npx -y @plur-ai/mcp@<version>`. The version is pinned in `.mcp.json` and changes only with a new plugin release. Node.js 22 or newer is required.

## Privacy

**Where your notes live.** In `~/.plur/` on your computer. Set `PLUR_PATH` to use another folder. Delete the folder to delete everything.

**What leaves your computer by default.**

- A version check to the npm registry (`registry.npmjs.org`), which sends the package name and no memory content.
- On first use of semantic search, a one-time download of the embedding model from Hugging Face. Set `PLUR_MODEL_DOWNLOAD=off` to prevent it; keyword search keeps working.

**What is off unless you turn it on.**

- Usage reporting. Set `PLUR_TELEMETRY=on` to send daily operation counts, the version and your operating system to `plur.ai`.
- Remote stores. Notes are sent to a server only if you add one.
- Language model features. If `OPENAI_API_KEY` or `OPENROUTER_API_KEY` is set in the server's environment, a few operations, such as duplicate checks and contradiction scans, send the text of the notes involved to that provider.

The full policy, including retention and contact details, is at [plur.ai/privacy](https://plur.ai/privacy).

## Support

Open an issue at [github.com/plur-ai/plur/issues](https://github.com/plur-ai/plur/issues). Documentation is at [docs.plur.ai](https://docs.plur.ai).
