/**
 * Owner decision H2 (round-2 board) on #1318 — auto-rate gives at most one
 * automatic verdict per engram per session, proved in the formal model
 * (R2CLI §FR5.Rate, `fixed_at_most_once`). Findings: r2-cli.md, C5-5.
 *
 * 1. A verdict is applied only when its write-ahead "rated" record landed.
 *    `appendIds` used to fail open and the verdict was applied anyway, so a
 *    failed record (full disk, quota, an unwritable file) let the same engram
 *    be rated again on every later turn.
 * 2. A stale worker lock is taken over atomically (claim by rename, then
 *    verify), never by a plain unlink — the pattern the model refutes
 *    (`InjectLock.old_removes_live`): a second contender that judged the same
 *    dead lock stale must not remove the lock the first one now holds.
 * 3. The Codex writer and reader derive the auto-rate session id the same way.
 *
 * Runs in-process with a stub store; TMPDIR points into a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ID = 'ENG-2026-09-29-00h2'
const STATEMENT = 'Tag every release candidate with the sprint number'
const REPLY = `Per the team rule: ${STATEMENT}. Tagged.`

describe('decision H2 — auto-rate at most once per engram per session', () => {
  let root: string
  let savedTmp: string | undefined
  let feedbackCalls: string[]

  const fakePlur = () => ({
    getByIds: async (ids: string[]) => ids.filter(i => i === ID).map(id => ({ id, statement: STATEMENT })),
    feedback: async (id: string) => { feedbackCalls.push(id) },
    config: {},
  })

  async function load() {
    vi.resetModules()
    return await import('../src/lib/auto-rate.js')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-h2-rate-'))
    savedTmp = process.env.TMPDIR
    process.env.TMPDIR = root
    delete process.env.PLUR_AUTO_RATE
    delete process.env.PLUR_AUTO_CAPTURE
    feedbackCalls = []
  })

  afterEach(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmp
    rmSync(root, { recursive: true, force: true })
  })

  async function turn(mod: Awaited<ReturnType<typeof load>>, session: string) {
    return mod.autoRateTurn({ editor: 'claude', sessionId: session, reply: REPLY, flags: {}, plur: fakePlur() as any })
  }

  it('good case: the same reply twice gives one verdict', async () => {
    const mod = await load()
    expect(mod.autoRateDir()).toBe(join(root, 'plur-auto-rate'))
    mod.recordInjected('claude', 'h2-ok', [ID])
    await turn(mod, 'h2-ok')
    await turn(mod, 'h2-ok')
    expect(feedbackCalls).toEqual([ID])
  })

  it('a verdict whose write-ahead record failed is skipped, on this turn and every later one', async () => {
    const mod = await load()
    mod.recordInjected('claude', 'h2-rec', [ID])
    // The record cannot be written: the .rated path is a directory.
    mkdirSync(join(root, 'plur-auto-rate', 'claude-h2-rec.rated'))
    await turn(mod, 'h2-rec')
    await turn(mod, 'h2-rec')
    expect(feedbackCalls).toEqual([])
  })

  it('a stale worker lock is taken over atomically: a late contender cannot remove the new holder\'s lock', async () => {
    const mod = await load()
    mkdirSync(join(root, 'plur-auto-rate'), { recursive: true, mode: 0o700 })
    const lock = join(root, 'plur-auto-rate', 'claude-h2-lock.worker')
    // A dead worker's lock. Two contenders read it and both judge it stale.
    const dead = '999999999'
    writeFileSync(lock, dead)
    // A takes it over and now holds a live lock.
    expect(mod.takeOverStaleWorkerLock(lock, dead)).toBe(true)
    expect(mod.acquireWorkerLock(lock)).toBe(true)
    const heldByA = readFileSync(lock, 'utf8')
    // B acts on what it read before A's takeover — the dead content.
    expect(mod.takeOverStaleWorkerLock(lock, dead)).toBe(false)
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe(heldByA)
  })

  it('the Codex reader takes the session id from the same fields as the Codex writer', async () => {
    vi.resetModules()
    const { readTurn } = await import('../src/commands/hook-auto-rate.js')
    const { codexSessionId } = await import('../src/lib/codex-hook-io.js')
    const payloads = [
      { session_id: 'cx-sid', last_assistant_message: 'reply' },
      { conversation_id: 'cx-conv', last_assistant_message: 'reply' },
      { session_id: 'cx-both', conversation_id: 'cx-other', last_assistant_message: 'reply' },
    ]
    for (const p of payloads) {
      expect(readTurn('codex', p)?.sessionId, JSON.stringify(p)).toBe(codexSessionId(p))
    }
  })
})
