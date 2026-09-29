# PR review summary — field-report work, 2026-09-29

Every open PR from the field-report work was reviewed with `/code-review`, one run per PR.
Each run read the diff and the code around it; most did not run the tests. Each finding
went back to the PR's author agent, which reproduced it with a failing test before fixing
it. If a finding did not reproduce, that is recorded too.

## Per PR

| PR | What it is | Findings | Status |
|---|---|---|---|
| #1270 (+#1315) | Windows hooks and MCP entries; opencode on by default | 3 + 3 | **Fixed** (c88ca8c6, 815e125a). **Open owner decision:** which shell runs hooks on Windows (below) |
| #1271 | Stop nudge delivered as `hookSpecificOutput` | 1: the checkpoint writer and its readers use different keys for non-UUID session ids | **Merged to main by a teammate.** The readers are fixed in #1301 (merged into #1276's branch) and #1314 (merged into #1277's branch). Main has the mismatch until #1276 and #1277 land. It does not affect UUID ids |
| #1272 | `plur stores add --url` | 1 low: no way to reassign a scope from the CLI | Being fixed (`--overwrite-scope`) |
| #1273 | Learn results report where the engram went | 0 | Clean |
| #1275 | Team save never absorbed; copy-on-promote | 4 (1 confirmed, 3 plausible) | **All 4 reproduced and fixed** (b05b4e8b) |
| #1276 | Memory injection that Claude Code delivers | 1: `plur-mcp init` still registers PostCompact | Fixed by #1300; **merge #1276 and #1300 together** |
| #1277 | Hooks and `plur sync` flush the outbox | 3: duplicate on a budget-cut push; silent when the breaker is open; store load eats the network budget | Being fixed |
| #1300 | `plur-mcp init` rehydrate on SessionStart(compact) | 2: duplicate rehydrate in global settings; crash on hooks without a command | Being fixed |
| #1301 | Session marker keyed on `session_id` | 1 medium: a killed or watchdog-stopped run leaves the lock, and retries are unbounded | Being fixed in a **new PR**, because #1301 was already merged into #1276's branch |
| #1307 | Surface outbox entries that can never succeed | 1: one scope's entries all get the first entry's reason | Being fixed |
| #1309 | A refusal does not trip the host breaker | 0 | Clean |
| #1314 | The session-end hook finds the checkpoint | 0 | Clean (merged into #1277's branch by a teammate) |
| #1316 | Regression test for session-end secret isolation | 0 | Clean (merged to main by a teammate) |
| #1318 | Auto-rate, and remote rating gated on the server's capability | 6, including: a quote used to correct a memory scored positive; remote engrams never rated from hooks | Being fixed |
| #1334 | Primary store never registered twice; canonicalize for missing paths | 2: a different-scope store sharing one file silently dropped; an `addStore` answer | **Fixed** (5885ca62). The trust changes moved to #1348 |
| #1340 | Secret guard: GitHub, GitLab, Slack, npm, Stripe, AWS | 1: the GitLab pattern matches hyphenated prose | Being fixed |
| #1341 | Memory delivered synchronously on the first prompt | 1: the lock check can race an in-flight acquisition | Being fixed |
| #1342 | Correction reminder folded into hook-inject | 0 | Clean |
| #1348 | Folder map core, with trust moved into it | 5, including: `project:` scopes refused; a downgrade resurrects revoked trust; a nonce burned on a failed save; no nonce needed when non-interactive | Being fixed |
| #1349 | Force-exiting hooks wait for their own store lock | 1: the same in-flight lock race as #1341 | Being fixed (an in-process lock counter in core) |

## Merge constraints found

- #1276 and #1300 must land together, or `plur-mcp init` installs a hook that delivers nothing.
- #1271 (already on main) needs the reader fixes in #1276 and #1277.
- The code changes on the integration branch that have to be carried into PRs are listed in
  `docs/audits/2026-09-29-integration-notes.md` on `integration/field-report-2026-09-29`.
- #1228 (the Lean formal-verification pass, not merged) conflicts with the field-report PRs in 9
  files. The formal workspace resolves these, and genuine disagreements are recorded there.

## Owner decision: the Windows hook shell (#1270)

#1270 quotes the hook command path on Windows so that a home folder with a space works. The
agent then checked which shell each editor uses to run hook commands on Windows:

| Editor | Shell | Source quality |
|---|---|---|
| Claude Code | Git Bash, or PowerShell if Git Bash is missing. Also has an exec form (command + args, no shell) | official docs |
| Codex | `pwsh -NoProfile -Command` | issue reports |
| Cursor | undocumented; reportedly PowerShell | third-party, unconfirmed |
| Antigravity | `cmd /C`, which escapes embedded quotes | third-party |

In PowerShell, a command that starts with a quoted path prints the path and does not run it.
So quoting on every Windows machine may break Codex, Antigravity, and Claude Code without Git
Bash, for **all** Windows users. The old unquoted form broke only for homes containing a space.
None of this is verified on a real Windows machine.

Options:
1. **Per editor.**
   - Claude Code: exec form (`node.exe` + js).
   - Codex: `& "<path>" hook-x`.
   - Antigravity: unquoted path, using the 8.3 short path when the path has a space.
   - Cursor: unchanged until its shell is confirmed.
2. **Stopgap:** quote only when the path contains whitespace, on Windows too. No regression for
   homes without spaces; still broken for homes with spaces on PowerShell editors.
3. **Hold #1270** until it is tested on a real Windows machine.

Recommendation: 2 now, 1 as a follow-up with a real-Windows check per editor.

## Not yet done

- Formal verification (datacore-dev `/formal-verify`): the workspace (integration + #1228) is
  being built. After that come the drift check and extending the models to the new guarantees.
- The three-pass audit (data loss, adversarial diff, evaluator panel), run on the refreshed
  integration branch.
