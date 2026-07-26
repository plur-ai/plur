/**
 * Injection telemetry attribution across concurrent sessions (convergence
 * Phase 2).
 *
 * `plur_inject` / `plur_inject_hybrid` attributed their pack counts to a
 * module-level `_activeSessionId`, assigned by session_start and cleared by
 * session_end, on the stated assumption that "MCP sessions are sequential
 * within a process". Once one process serves concurrent sessions that is false:
 * the second session_start overwrites the variable, so an inject belonging to
 * the first session is recorded against the second, and the first session's
 * end-of-session summary reports someone else's numbers.
 *
 * The fix derives the implicit session instead of storing it, and answers only
 * when it is unambiguous. So: unchanged with one session open, no
 * misattribution with several, and an explicit `session_id` always wins.
 *
 * Every task below deliberately matches the seeded engram — telemetry is only
 * recorded for injections that actually returned something, so a non-matching
 * task would make the counts meaningless.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const SEED = 'Always run the full test suite before committing'
const TASK = 'run the full test suite before committing'

describe('injection telemetry attribution', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  const start = async () => (await call('plur_session_start', { task: TASK })).session_id as string
  const end = async (session_id: string) =>
    (await call('plur_session_end', { session_id, summary: 'done' })).injection_summary
      ?.total_injections ?? 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-attr-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    plur.learn(SEED, { scope: 'global' })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('attributes an untagged inject to the single open session (unchanged)', async () => {
    const a = await start()
    await call('plur_inject', { task: TASK })
    // session_start's own injection plus the explicit one.
    expect(await end(a)).toBe(2)
  })

  it('drops an untagged inject rather than charging it to the wrong session', async () => {
    const a = await start()
    const b = await start()

    // Two sessions open: this injection has no correct owner.
    await call('plur_inject', { task: TASK })

    // Each session counts only its own session_start injection. Under the
    // stored `_activeSessionId` the ambiguous one was charged to B — whichever
    // session happened to start last.
    expect(await end(a)).toBe(1)
    expect(await end(b)).toBe(1)
  })

  it('an explicit session_id attributes correctly with several sessions open', async () => {
    const a = await start()
    const b = await start()

    await call('plur_inject', { task: TASK, session_id: a })
    await call('plur_inject', { task: TASK, session_id: a })
    await call('plur_inject_hybrid', { task: TASK, session_id: b })

    expect(await end(a)).toBe(3) // session_start + 2 explicit
    expect(await end(b)).toBe(2) // session_start + 1 explicit
  })

  it('implicit attribution recovers once only one session is left open', async () => {
    const a = await start()
    const b = await start()

    await end(a)
    // B is the only open session again, so the implicit answer is unambiguous.
    await call('plur_inject', { task: TASK })

    expect(await end(b)).toBe(2)
  })

  it('both inject tools accept an explicit session_id in their schema', () => {
    for (const name of ['plur_inject', 'plur_inject_hybrid']) {
      const tool = tools.find(t => t.name === name)!
      expect((tool.inputSchema as any).properties.session_id).toBeDefined()
    }
  })
})
