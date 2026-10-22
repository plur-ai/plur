# Enterprise installation promises

These deterministic checks use temporary homes, real local stores and loopback
HTTP services. Setup and migration launch the built production CLI and MCP server;
the other checks import source so their recorded mutants affect execution.

Build the workspace first. Migration needs the real Codex CLI on PATH for its
configuration registration commands, matching ordinary repository CI:
`npm install -g --no-audit --no-fund @openai/codex@0.160.1`.
The checks make no agent or paid model calls. They do not replace native installer
CI or certify a deployed enterprise server.

| Promise | Required behavior | Build row |
| --- | --- | --- |
| EFI-1 | Repository routing and local isolation | B9b |
| EFI-2 | Save destination reporting | B10 |
| EFI-3 | Cached session status | B11a |
| EFI-4 | Hook and MCP session status | B11b |
| EFI-5 | Queued delivery after server/key replacement | B12 |
| EFI-6 | Complete server permission checks | B13a |
| EFI-7 | Doctor fails unavailable evidence | B13b |
| EFI-8 | Conflicting workspace destinations require a choice | B15 |
| EFI-9 | Safe legacy credential cleanup | C9 |
| EFI-10 | Selected eligible uploads only | C11a |
| EFI-11 | Read-only preview and explicit confirmation | C11b |

Each promise has a recorded `evals/mutants/EFI-<n>-1.patch`. Run the full gate with
`npm run evals:gate`; check their bite with
`npm run evals:bite -- --only EFI-1,EFI-2,EFI-3,EFI-4,EFI-5,EFI-6,EFI-7,EFI-8,EFI-9,EFI-10,EFI-11`.

EFI-12 (proven setup, rollback and key reuse) and EFI-13 (recoverable upgrade) moved on
2026-10-22 to plur-ai/enterprise with the `plur-enterprise` package they test.
