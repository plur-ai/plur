import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * #1274: Claude Code only delivers a hook's context to the model when it is
 * wrapped as `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":...}}`,
 * with `hookEventName` matching the firing event. A top-level
 * `{"additionalContext":...}` is recorded as plain hook stdout and dropped.
 * These tests pin the shape for every event hook-inject is registered on.
 */
describe('hook-inject output shape (#1274)', () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-shape-'))
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    // Codeword fixture so event injections (which print nothing on 0 matches) fire.
    const seeded = runCli('node', [CLI, 'learn', 'codeword zephyr-quartz applies to planning skills agents and subagents', '--json'], {
      encoding: 'utf-8', timeout: 20_000, env, cwd: dir,
    })
    expect(seeded.status).toBe(0)
  }, 30_000)

  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  beforeEach(() => {
    // Fresh per-session state (keyed on ppid = this process) for each case.
    rmSync(join(dir, 'tmp', 'plur-sessions'), { recursive: true, force: true })
  })

  function run(args: string[], input: object): { stdout: string; status: number } {
    const r = runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify(input), encoding: 'utf-8', timeout: 20_000, env, cwd: dir,
    })
    return { stdout: r.stdout ?? '', status: r.status ?? 1 }
  }

  function expectShape(stdout: string, eventName: string): string {
    const parsed = JSON.parse(stdout) as Record<string, any>
    expect(parsed.additionalContext).toBeUndefined()
    expect(parsed.hookSpecificOutput?.hookEventName).toBe(eventName)
    expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string')
    return parsed.hookSpecificOutput.additionalContext as string
  }

  it('UserPromptSubmit first message uses the UserPromptSubmit shape', () => {
    const r = run([], { hook_event_name: 'UserPromptSubmit', prompt: 'zephyr-quartz codeword' })
    expect(r.status).toBe(0)
    expect(expectShape(r.stdout, 'UserPromptSubmit')).toContain('session started')
  }, 30_000)

  it('UserPromptSubmit shape is used even when the payload omits hook_event_name', () => {
    const r = run([], { prompt: 'zephyr-quartz codeword' })
    expect(expectShape(r.stdout, 'UserPromptSubmit')).toContain('session started')
  }, 30_000)

  it('the periodic reminder uses the UserPromptSubmit shape', () => {
    const sessions = join(dir, 'tmp', 'plur-sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, `${process.pid}.marker`), JSON.stringify({ task: 't', sessionId: 's' }))
    // No .reminded file = reminder due.
    const r = run([], { hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    expect(expectShape(r.stdout, 'UserPromptSubmit')).toContain('Memory Reminder')
  }, 30_000)

  // PostCompact cannot carry context: Claude Code 2.1.284 rejects
  // hookSpecificOutput.hookEventName "PostCompact" ("Hook JSON output
  // validation failed") and ignores a top-level additionalContext. Rehydration
  // therefore runs on SessionStart (matcher "compact"), which fires right after
  // compaction and does deliver.
  it('--rehydrate on SessionStart(compact) uses the SessionStart shape', () => {
    const r = run(['--rehydrate'], { hook_event_name: 'SessionStart', source: 'compact', compact_summary: 'zephyr-quartz' })
    expect(expectShape(r.stdout, 'SessionStart')).toContain('rehydrated after compaction')
  }, 30_000)

  it('--rehydrate defaults to SessionStart without hook_event_name', () => {
    const r = run(['--rehydrate'], { compact_summary: 'zephyr-quartz' })
    expectShape(r.stdout, 'SessionStart')
  }, 30_000)

  it('--rehydrate from a stale PostCompact registration prints nothing', () => {
    // Output there is rejected with a visible validation error; silence until
    // `plur init` is re-run and moves the hook to SessionStart.
    const r = run(['--rehydrate'], { hook_event_name: 'PostCompact', compact_summary: 'zephyr-quartz' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  }, 30_000)

  it('--rehydrate recovers the session task by payload session_id', () => {
    // SessionStart(compact) payloads carry no compact_summary, and the ppid
    // marker is written by a different process tree, so the rehydrate query
    // must come from state keyed on the Claude Code session_id.
    const sid = '11111111-2222-3333-4444-555555555555'
    run([], { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'zephyr-quartz codeword' })
    rmSync(join(dir, 'tmp', 'plur-sessions', `${process.pid}.marker`), { force: true })
    const r = run(['--rehydrate'], { hook_event_name: 'SessionStart', source: 'compact', session_id: sid })
    expect(expectShape(r.stdout, 'SessionStart')).toContain('zephyr-quartz')
  }, 30_000)

  for (const [event, input] of [
    ['plan_mode', { tool_name: 'EnterPlanMode', prompt: 'zephyr-quartz planning' }],
    ['skill', { tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' } }],
    ['agent', { tool_name: 'Agent', tool_input: { subagent_type: 'zephyr-quartz', prompt: 'agents' } }],
  ] as const) {
    it(`--event ${event} uses the PreToolUse shape`, () => {
      const r = run(['--event', event], { hook_event_name: 'PreToolUse', ...input })
      expect(expectShape(r.stdout, 'PreToolUse')).toContain(`[PLUR Memory — ${event}]`)
    }, 30_000)

    it(`--event ${event} defaults to PreToolUse without hook_event_name`, () => {
      const r = run(['--event', event], input)
      expectShape(r.stdout, 'PreToolUse')
    }, 30_000)
  }

  it('--event subagent uses the SubagentStart shape', () => {
    const r = run(['--event', 'subagent'], { hook_event_name: 'SubagentStart', agent_type: 'zephyr-quartz', tool_input: { description: 'zephyr-quartz subagents' } })
    expect(expectShape(r.stdout, 'SubagentStart')).toContain('[PLUR Memory — subagent]')
  }, 30_000)

  it('--event subagent defaults to SubagentStart without hook_event_name', () => {
    const r = run(['--event', 'subagent'], { tool_input: { description: 'zephyr-quartz subagents' } })
    expectShape(r.stdout, 'SubagentStart')
  }, 30_000)

  it('the payload hook_event_name wins over the flag default', () => {
    // hookEventName must match the event that actually fired; a hook
    // registered under an unexpected event still answers in its shape.
    const r = run(['--event', 'agent'], { hook_event_name: 'SubagentStart', tool_input: { subagent_type: 'zephyr-quartz' } })
    expectShape(r.stdout, 'SubagentStart')
  }, 30_000)

  it('an unknown --event prints nothing instead of echoing the payload', () => {
    const r = run(['--event', 'nonsense'], { hook_event_name: 'PreToolUse', tool_name: 'X' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  }, 30_000)
})
