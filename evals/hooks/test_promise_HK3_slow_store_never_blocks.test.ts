// HK-3: A slow or broken memory store never blocks or traps my session.
//
// The hooks are run from source as separate processes, as Claude Code runs
// them. "Blocks" has a hard edge here: Claude Code registers the first-message
// hook with a 20-second timeout and kills it there, showing the user a hook
// error and giving the agent nothing. So the hook must finish, exit 0, inside
// 20 seconds whatever the store does. "Traps" is the session guard: a session
// whose memory server never starts must not have its tools refused for good.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookHome, prompt, runSource, seed, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

const SLOW_STORE = join(__dirname, '..', 'helpers', 'agent-tools-hooks-slow-store.mjs')
const CLAUDE_KILLS_HOOK_AFTER_MS = 20_000
const MEMORY = 'Billing service deploys always use blue-green rollouts'

describe('HK-3 a slow or broken store never blocks or traps the session', () => {
  let h: HookHome
  afterEach(() => h?.cleanup())

  it('semantic search hangs: the first message still arrives in time, with keyword-search memories', () => {
    h = hookHome()
    seed(h, MEMORY)
    const r = prompt(h, 'hk3-hybrid', 'How do I deploy the billing service?', {
      preload: SLOW_STORE, env: { PLUR_EVAL_STORE: 'hang-hybrid' }, timeoutMs: 40_000,
    })
    expect(r.ms, `the hook ran ${r.ms} ms with a hung semantic search; Claude Code kills it at ${CLAUDE_KILLS_HOOK_AFTER_MS} ms`)
      .toBeLessThan(CLAUDE_KILLS_HOOK_AFTER_MS)
    expect(r.status, `the hook did not exit cleanly: status ${r.status}, stderr: ${r.stderr.slice(0, 300)}`).toBe(0)
    expect(r.context, `the fallback served no memories; the agent got: "${r.context}"`).toContain(MEMORY)
  }, 60_000)

  it('every search hangs: the hook still ends in time and exits cleanly', () => {
    h = hookHome()
    seed(h, MEMORY)
    const r = prompt(h, 'hk3-all', 'How do I deploy the billing service?', {
      preload: SLOW_STORE, env: { PLUR_EVAL_STORE: 'hang-all' }, timeoutMs: 40_000,
    })
    expect(r.ms, `the hook ran ${r.ms} ms against a store that never answers; Claude Code kills it at ${CLAUDE_KILLS_HOOK_AFTER_MS} ms`)
      .toBeLessThan(CLAUDE_KILLS_HOOK_AFTER_MS)
    expect(r.status, `the hook did not exit cleanly against a hung store: status ${r.status}, stderr: ${r.stderr.slice(0, 300)}`).toBe(0)
  }, 60_000)

  it('memory server never starts: the session guard nudges once, then lets every tool through', () => {
    h = hookHome()
    const guard = (tool: string) => runSource('cli', ['hook-session-guard'], {
      env: h.env, cwd: h.home,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'hk3-guard', tool_name: tool, cwd: h.home }),
    })
    const denied = (stdout: string) => stdout.includes('"permissionDecision":"deny"')

    const first = guard('Bash')
    expect(first.status, `the guard failed: ${first.stderr}`).toBe(0)
    expect(denied(first.stdout), `precondition: the first tool call is nudged toward session start; got: ${first.stdout}`).toBe(true)

    for (const tool of ['Bash', 'Edit', 'Read', 'Write']) {
      const later = guard(tool)
      expect(later.status, `the guard failed: ${later.stderr}`).toBe(0)
      expect(denied(later.stdout), `the guard refused ${tool} again after its one nudge; the session is trapped: ${later.stdout}`).toBe(false)
    }
  }, 60_000)
})
