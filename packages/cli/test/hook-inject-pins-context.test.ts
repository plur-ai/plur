/**
 * End to end through the built `hook-inject`:
 *  - H7: a subagent (payload `agent_id`) is its own pin context — its
 *    SubagentStart gets the pins and records them for that subagent only, a
 *    skill inside it then leaves them out, and the main context's marker is
 *    not touched (a skill in the main context before the main delivery still
 *    gets them).
 *  - H9: a delivery is recorded only when the injected block actually held a
 *    pinned engram. A first prompt on a store with no pins records nothing, so
 *    a pin added afterwards reaches the next skill event.
 *
 * Temp HOME / PLUR_PATH / TMPDIR only — never ~/.plur.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

function setup(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_DISABLE_EMBEDDINGS: '1' }
  delete (env as Record<string, unknown>).CLAUDE_SESSION_ID
  const run = (args: string[], input: object): string => {
    const r = runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.status).toBe(0)
    const out = (r.stdout ?? '').trim()
    return out ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : ''
  }
  return { dir, run }
}

describe('hook-inject: subagent pin context (H7)', () => {
  let ctx: ReturnType<typeof setup>
  let pinId: string
  beforeAll(async () => {
    ctx = setup('plur-pinctx-h7-')
    const plur = new Plur({ path: join(ctx.dir, '.plur') })
    pinId = (await plur.learn('PINMARK always answer in plain language', { scope: 'global', type: 'behavioral', pinned: true } as never)).id
    await plur.learn('codeword zephyr-quartz applies to planning skills agents and subagents', { scope: 'global', type: 'behavioral' })
  }, 30_000)
  afterAll(() => rmSync(ctx.dir, { recursive: true, force: true }))

  const skill = (extra: object) => ctx.run(['--event', 'skill'], { session_id: 'H7', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' }, ...extra })

  it('the subagent records for itself; the main context is unaffected', () => {
    const sub = ctx.run(['--event', 'subagent'], { session_id: 'H7', hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'zephyr-quartz planner' })
    expect(sub).toContain(pinId)
    // Inside the subagent: its context has the pins now.
    expect(skill({ agent_id: 'agent-1', agent_type: 'zephyr-quartz planner' })).not.toContain(pinId)
    // Main context (no agent id): nothing delivered there yet → included.
    expect(skill({})).toContain(pinId)
    // A second subagent's skill, before its own start delivered: included.
    expect(skill({ agent_id: 'agent-2', agent_type: 'other' })).toContain(pinId)
  }, 120_000)
})

describe('hook-inject: a delivery without pins is not recorded (H9)', () => {
  let ctx: ReturnType<typeof setup>
  beforeAll(async () => {
    ctx = setup('plur-pinctx-h9-')
    const plur = new Plur({ path: join(ctx.dir, '.plur') })
    await plur.learn('codeword zephyr-quartz applies to planning skills agents and subagents', { scope: 'global', type: 'behavioral' })
  }, 30_000)
  afterAll(() => rmSync(ctx.dir, { recursive: true, force: true }))

  it('a pin learned after a pin-less first prompt reaches the next skill event', async () => {
    const first = ctx.run([], { session_id: 'H9', hook_event_name: 'UserPromptSubmit', prompt: 'zephyr-quartz planning codeword please' })
    expect(first).toContain('session started')
    const plur = new Plur({ path: join(ctx.dir, '.plur') })
    const pinId = (await plur.learn('PINMARK always answer in plain language', { scope: 'global', type: 'behavioral', pinned: true } as never)).id
    const ev = ctx.run(['--event', 'skill'], { session_id: 'H9', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' } })
    expect(ev).toContain(pinId)
  }, 120_000)
})
