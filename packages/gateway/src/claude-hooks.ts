/**
 * The Claude Code hook set PLUR installs, shared by `plur init` and
 * `plur-mcp init` so both write the same hooks.
 */

/**
 * The Claude Code timeout for the synchronous `hook-inject` registrations
 * (UserPromptSubmit and SessionStart matcher "compact"), in seconds.
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

export interface HookEntry {
  matcher?: string
  hooks: Array<{
    type: string
    command: string
    /** Exec form (decision H3, Windows): argv spawned with no shell. */
    args?: string[]
    timeout?: number
    async?: boolean
  }>
}

/**
 * Builds the launch part of one Claude Code hook: `{ command }` (a shell
 * string, darwin/linux) or `{ command, args }` (exec form, Windows).
 * See `claudeHookSpec`.
 */
export type HookLaunch = (sub: string, ...extra: string[]) => { command: string; args?: string[] }

/**
 * A plain command prefix (`npx @plur-ai/cli`, a shim path) is the shell
 * string form, `<prefix> <sub> [args]`. @plur-ai/mcp's tests pin its mirrored
 * hook set to these builders by passing such a prefix.
 */
export function asHookLaunch(launch: HookLaunch | string): HookLaunch {
  if (typeof launch !== 'string') return launch
  return (sub, ...extra) => ({ command: [launch, sub, ...extra].join(' ') })
}

// ── Hook map builders ───────────────────────────────────────────────────────
// Parameterized by command prefix so the same definitions work with both
// the local shim (default) and npx fallback.

// Enforcement hooks ensure plur_session_start is always called first.
// Installed into global ~/.claude/settings.json unconditionally (issue #95) so
// they fire from any subdirectory project. Each hook silent-passes unless the
// folder map says on (#1347), so folders without plur are unaffected.
export function buildEnforcementHooks(launch: HookLaunch | string): Record<string, HookEntry[]> {
  const mk = asHookLaunch(launch)
  return {
    SessionStart: [
      {
        hooks: [
          { type: 'command', ...mk('hook-session-remind'), timeout: 3 },
        ],
      },
      // `claude --resume` keeps the session id, and SessionEnd below deleted
      // its folder-question nonces: forget that the session was asked, so the
      // resumed session asks again with a fresh nonce (#1347, option C). In
      // the same file as SessionEnd, so the pair is always installed together.
      {
        matcher: 'resume',
        hooks: [
          { type: 'command', ...mk('hook-session-resume'), timeout: 3 },
        ],
      },
    ],

    // Auto-close the memory lifecycle when the session ends (Claude Code
    // SessionEnd, shipped v1.0.85). Captures a closing episode and cleans up
    // the checkpoint even if the agent forgot to call plur_session_end (#217).
    SessionEnd: [
      {
        hooks: [
          { type: 'command', ...mk('hook-session-end'), timeout: 5 },
        ],
      },
    ],

    PreToolUse: [
      // Session guard — blocks all tools until plur_session_start is called.
      // Must be first so it runs before any other PreToolUse hook.
      {
        matcher: '*',
        hooks: [
          { type: 'command', ...mk('hook-session-guard'), timeout: 3 },
        ],
      },
    ],

    PostToolUse: [
      // Session sentinel — creates marker file after plur_session_start succeeds
      {
        // Same rule as the guard's exemption (any `mcp__<server>__plur_session_start`),
        // so a plugin-named server still marks the session started.
        matcher: 'mcp__.*__plur_session_start',
        hooks: [
          { type: 'command', ...mk('hook-session-mark'), timeout: 3 },
        ],
      },
    ],
  }
}

// Injection hooks pull relevant engrams into the conversation context. Installed
// at the path chosen by --global/--project (default project) because per-project
// domain/scope tuning may matter for what gets injected.
export function buildInjectionHooks(launch: HookLaunch | string): Record<string, HookEntry[]> {
  const mk = asHookLaunch(launch)
  return {
    // First message: inject engrams based on the prompt.
    // Subsequent messages: periodic reminder to call plur_learn (~0.1s).
    //
    // Sync (#1313): async context arrives only at the next safe point, so a
    // first reply without tool calls, and every `claude -p`, had no memory.
    // hook-inject bounds its own work below the timeout (hybrid on a soft
    // deadline, then BM25; a self-watchdog). Re-running init rewrites old
    // `async: true` entries, since every plur hook is stripped and re-added.
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', ...mk('hook-inject'), timeout: CLAUDE_INJECT_TIMEOUT_S },
        ],
      },
    ],

    // Re-inject after context compaction so engrams survive long conversations.
    // SessionStart with matcher "compact" fires right after compaction and can
    // carry context; PostCompact cannot (#1274). Re-running init strips the
    // old PostCompact entry with the rest of the plur hooks.
    SessionStart: [
      {
        matcher: 'compact',
        hooks: [
          { type: 'command', ...mk('hook-inject', '--rehydrate'), timeout: CLAUDE_INJECT_TIMEOUT_S },
        ],
      },
    ],

    PreToolUse: [
      // Full injection when entering plan mode — planning needs broad context
      {
        matcher: 'EnterPlanMode',
        hooks: [
          { type: 'command', ...mk('hook-inject', '--event', 'plan_mode'), timeout: 10 },
        ],
      },
      // Domain-specific engrams when a skill is invoked
      {
        matcher: 'Skill',
        hooks: [
          { type: 'command', ...mk('hook-inject', '--event', 'skill'), timeout: 10 },
        ],
      },
      // Agent-scoped engrams when spawning an agent
      {
        matcher: 'Agent',
        hooks: [
          { type: 'command', ...mk('hook-inject', '--event', 'agent'), timeout: 10 },
        ],
      },
      // Observation capture — log tool calls for offline pattern extraction
      {
        matcher: 'Bash|Edit|Write|Agent',
        hooks: [
          { type: 'command', ...mk('hook-observe'), timeout: 3 },
        ],
      },
    ],

    PostToolUse: [
      {
        matcher: 'Bash|Edit|Write|Agent',
        hooks: [
          { type: 'command', ...mk('hook-observe', '--post'), timeout: 3 },
        ],
      },
    ],

    // Inject agent-scoped engrams into subagent context
    SubagentStart: [
      {
        matcher: '.*',
        hooks: [
          { type: 'command', ...mk('hook-inject', '--event', 'subagent'), timeout: 10 },
        ],
      },
    ],

    // Learning reflection — nudge the LLM to call plur_learn after responses
    // where it discovered or learned something. Fires after a correction, preference or
    // decision in the user's last message, plus every 10th Stop as a fallback.
    Stop: [
      {
        matcher: '*',
        hooks: [
          { type: 'command', ...mk('hook-learn-check'), timeout: 2 },
        ],
      },
      // Auto-rate injected engrams from the reply (#1310). Its own entry.
      // Synchronous on purpose: verified in a real `claude -p` session, an
      // async Stop hook is killed when the session exits and never rates the
      // last (in headless mode, the only) reply. It skips without opening the
      // store when nothing was injected, and is bounded well inside 10s.
      {
        matcher: '*',
        hooks: [
          { type: 'command', ...mk('hook-auto-rate', 'claude'), timeout: 10 },
        ],
      },
    ],
  }
}

export function mergeHookMaps(
  a: Record<string, HookEntry[]>,
  b: Record<string, HookEntry[]>,
): Record<string, HookEntry[]> {
  const out: Record<string, HookEntry[]> = {}
  for (const [event, entries] of Object.entries(a)) out[event] = [...entries]
  for (const [event, entries] of Object.entries(b)) {
    out[event] = [...(out[event] ?? []), ...entries]
  }
  return out
}

/** Every hook PLUR installs into Claude Code settings: enforcement, then injection. */
export function buildClaudeHooks(launch: HookLaunch | string): Record<string, HookEntry[]> {
  return mergeHookMaps(buildEnforcementHooks(launch), buildInjectionHooks(launch))
}
