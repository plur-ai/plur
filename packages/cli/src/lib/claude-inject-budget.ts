/**
 * The Claude Code timeout for the synchronous `hook-inject` registrations
 * (UserPromptSubmit and SessionStart matcher "compact"), in seconds (#1313).
 *
 * Both are sync so the first reply of a session, a one-shot `claude -p`, and
 * the first reply after compaction see memory. A sync hook blocks the prompt,
 * so this is a hard budget, and hook-inject bounds its own work below it:
 * hybrid search on an 8s soft deadline (`injectWithFallback`), then BM25, and
 * a 15s self-watchdog (`HOOK_CEILING_DEFAULT_MS`) that exits 0 before Claude
 * Code would kill the hook and report an error.
 *
 * Measured on a 10,000-engram store (10.6 MB of YAML, warm embedding cache),
 * each run a fresh process through `/bin/sh -c`: first prompt 2.3 to 2.5s,
 * rehydrate 2.3 to 2.7s, later prompts 68 to 101ms (bare `node -e 0`: 34ms).
 * With no embedding cache the deadline is missed and BM25 serves the turn in
 * 9.1 to 9.3s. 20s covers that with room to spare, sits at Antigravity's
 * budget and below Codex's 25s. See docs/runbooks/hook-timeouts.md.
 */
export const CLAUDE_INJECT_TIMEOUT_S = 20
