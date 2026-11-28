/**
 * W2+4 / R7 (overhaul), end to end through the built `hook-inject`:
 *   - the first prompt delivers the pins and records it for the epoch;
 *   - a skill, agent or plan-mode event in the same context leaves pins out;
 *   - a subagent start always includes them;
 *   - SessionStart(compact) bumps the epoch, the rehydration re-delivers;
 *   - fail open: with no recorded delivery (a session start that timed out,
 *     or a compaction whose rehydration did not finish), events include pins.
 * Event injections run the same pipeline (hybrid on a soft deadline, keyword
 * fallback), and an event injection under a scope label builds its query
 * from the stored session task (W5).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('hook-inject: pins once per context (R7)', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let pinId: string
  let skillId: string
  let taskId: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pin-epoch-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    env = {
      ...process.env,
      HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    const plur = new Plur({ path: join(dir, '.plur') })
    pinId = (await plur.learn('PINMARK always answer in plain language', { scope: 'global', type: 'behavioral', pinned: true } as never)).id
    skillId = (await plur.learn('codeword zephyr-quartz applies to planning skills agents and subagents', { scope: 'global', type: 'behavioral' })).id
    taskId = (await plur.learn('The invoice exporter retries failed ledger uploads three times', { scope: 'global', type: 'behavioral' })).id
  }, 30_000)

  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  beforeEach(() => { rmSync(join(dir, 'tmp', 'plur-sessions'), { recursive: true, force: true }) })

  function run(args: string[], input: object, extraEnv: Record<string, string> = {}): string {
    const r = runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf-8', timeout: 30_000, env: { ...env, ...extraEnv }, cwd: dir,
    })
    expect(r.status).toBe(0)
    const out = (r.stdout ?? '').trim()
    if (!out) return ''
    return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  }
  const skill = (sid: string) => run(['--event', 'skill'], { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' } })

  it('first prompt delivers pins; the skill event in the same context leaves them out; a subagent gets them', () => {
    const first = run([], { session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'zephyr-quartz planning codeword please' })
    expect(first).toContain(pinId)
    const ev = skill('S1')
    expect(ev).toContain(skillId)
    expect(ev).not.toContain(pinId)
    const plan = run(['--event', 'plan_mode'], { session_id: 'S1', hook_event_name: 'PreToolUse', prompt: 'zephyr-quartz planning' })
    expect(plan).not.toContain(pinId)
    const sub = run(['--event', 'subagent'], { session_id: 'S1', hook_event_name: 'SubagentStart', agent_type: 'zephyr-quartz planner' })
    expect(sub).toContain(pinId)
  }, 120_000)

  it('compaction bumps the epoch; the rehydration re-delivers and the next skill event leaves pins out again', () => {
    run([], { session_id: 'S2', hook_event_name: 'UserPromptSubmit', prompt: 'zephyr-quartz planning codeword please' })
    expect(skill('S2')).not.toContain(pinId)
    const re = run(['--rehydrate'], { session_id: 'S2', hook_event_name: 'SessionStart', source: 'compact' })
    expect(re).toContain(pinId)
    expect(skill('S2')).not.toContain(pinId)
  }, 120_000)

  it('fail open: no recorded session start → the skill event includes pins', () => {
    expect(skill('S3')).toContain(pinId)
  }, 60_000)

  it('fail open: a new epoch with no delivery yet (resume) → the skill event includes pins', () => {
    run([], { session_id: 'S4', hook_event_name: 'UserPromptSubmit', prompt: 'zephyr-quartz planning codeword please' })
    expect(skill('S4')).not.toContain(pinId)
    // SessionStart(resume) starts a new epoch; nothing re-delivers the pins.
    const r = runCli('node', [CLI, 'hook-session-resume'], {
      input: JSON.stringify({ cwd: dir, session_id: 'S4', hook_event_name: 'SessionStart', source: 'resume' }),
      encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.status).toBe(0)
    expect(skill('S4')).toContain(pinId)
    // The event that included them recorded the delivery: the next one leaves them out.
    expect(skill('S4')).not.toContain(pinId)
  }, 120_000)

  it('a skill event builds its query from the stored session task (W5)', () => {
    run([], { session_id: 'S5', hook_event_name: 'UserPromptSubmit', prompt: 'fix the invoice exporter ledger upload retries' })
    const ev = run(['--event', 'skill'], { session_id: 'S5', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'review' } })
    expect(ev).toContain(taskId)
  }, 120_000)
})
