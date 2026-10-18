/**
 * TOOL-4 product tests (2026-10-18).
 *
 * 1. plur_learn_batch never overwrites an existing memory (owner decision
 *    2026-10-18). A duplicate checker answering UPDATE or MERGE saves the item
 *    as its own memory, linked to the existing one, and the per-item result
 *    names the likely duplicate. Because it never overwrites, it is NOT marked
 *    destructive and stays behind plur_admin (owner decision 2026-10-18: the
 *    promise is proven by behaviour, not by the marking); through the gateway
 *    it behaves exactly as when called directly.
 * 2. plur_report_failure rewrites a procedure's text with whatever its checker
 *    returns, so it is marked destructive, is a direct tool in every profile,
 *    and the gateway refuses it. What it does is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, CURSOR_CORE_TOOL_NAMES } from '../src/tools.js'

const OLD = 'Write release summaries as three bullets followed by one explicit next action.'
const INCOMING = 'Write release summaries as five bullets followed by one explicit next action.'
const PROC = 'To roll back the ledger service, revert the release tag and redeploy the previous image'

const tool = (profile: 'full' | 'lean' | 'cursor', name: string) => getToolDefinitions(profile).find(t => t.name === name)

describe('TOOL-4: plur_learn_batch is an ordinary gateway action, not destructive', () => {
  it('plur_learn_batch is annotated destructiveHint:false', () => {
    expect(tool('full', 'plur_learn_batch')?.annotations?.destructiveHint).toBe(false)
  })

  it('plur_learn_batch is not a lean/cursor direct tool and plur_admin offers it', async () => {
    expect(CURSOR_CORE_TOOL_NAMES.has('plur_learn_batch')).toBe(false)
    expect(tool('lean', 'plur_learn_batch')).toBeUndefined()
    expect(tool('full', 'plur_learn_batch')).toBeDefined()
    const admin = tool('lean', 'plur_admin')!
    const dir = mkdtempSync(join(tmpdir(), 'plur-tool4-help-'))
    try {
      const help = await admin.handler({ action: 'help' }, new Plur({ path: dir })) as any
      expect(help.actions.map((a: { action: string }) => a.action)).toContain('plur_learn_batch')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('TOOL-4: plur_report_failure is marked destructive, direct, and refused by the gateway', () => {
  for (const name of ['plur_report_failure']) {
    it(`${name} is annotated destructiveHint:true`, () => {
      expect(tool('full', name)?.annotations?.destructiveHint).toBe(true)
    })

    it(`${name} is a direct tool in every profile`, () => {
      expect(CURSOR_CORE_TOOL_NAMES.has(name)).toBe(true)
      for (const profile of ['full', 'lean', 'cursor'] as const) {
        expect(tool(profile, name), `${name} in ${profile}`).toBeDefined()
      }
    })

    it(`plur_admin does not offer ${name}`, async () => {
      const admin = tool('lean', 'plur_admin')!
      const dir = mkdtempSync(join(tmpdir(), 'plur-tool4-help-'))
      try {
        const help = await admin.handler({ action: 'help' }, new Plur({ path: dir })) as any
        expect(help.actions.map((a: { action: string }) => a.action)).not.toContain(name)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  }
})

describe('TOOL-4: behaviour over the tools', () => {
  let dir: string
  let plur: Plur
  let prevKey: string | undefined
  let prevRouter: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-tool4-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
    prevKey = process.env.OPENAI_API_KEY
    prevRouter = process.env.OPENROUTER_API_KEY
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey
    if (prevRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevRouter
    rmSync(dir, { recursive: true, force: true })
  })

  /** Script the environment-configured duplicate checker. No network. */
  function scriptChecker(answer: () => string): { calls: number } {
    const state = { calls: 0 }
    process.env.OPENAI_API_KEY = 'test-only-synthetic-token'
    delete process.env.OPENROUTER_API_KEY
    vi.stubGlobal('fetch', async () => {
      state.calls++
      return new Response(JSON.stringify({ choices: [{ message: { content: answer() } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    })
    return state
  }

  for (const decision of ['UPDATE', 'MERGE'] as const) {
    it(`plur_learn_batch with the checker answering ${decision}: old text unchanged, item saved, linked, and the result says so`, async () => {
      const old = await plur.learn(OLD, { scope: 'global' })
      const checker = scriptChecker(() => `DECISION: ${decision}\nTARGET: ${old.id}\nREASON: scripted`)

      const res = await tool('full', 'plur_learn_batch')!.handler({ engrams: [{ statement: INCOMING, scope: 'global' }] }, plur) as any

      expect(checker.calls, 'precondition: the duplicate checker was asked').toBeGreaterThan(0)
      const fresh = new Plur({ path: dir })
      expect((await fresh.getById(old.id))?.statement).toBe(OLD)
      const item = res.results[0]
      expect(item.decision).toBe('ADD')
      expect(item.id).not.toBe(old.id)
      const added = (await fresh.list()).find(e => e.statement === INCOMING)
      expect(added, 'the incoming item was saved as its own memory').toBeDefined()
      expect(added!.relations?.related ?? []).toContain(old.id)
      expect(item.likely_duplicate_of?.id).toBe(old.id)
      expect(item.likely_duplicate_of?.checker_decision).toBe(decision)
      expect(String(item.likely_duplicate_of?.note)).toMatch(/never overwrite/i)
    })
  }

  for (const decision of ['UPDATE', 'MERGE'] as const) {
    it(`plur_learn_batch through plur_admin with the checker answering ${decision}: runs, never overwrites, saves the item linked`, async () => {
      const old = await plur.learn(OLD, { scope: 'global' })
      const checker = scriptChecker(() => `DECISION: ${decision}\nTARGET: ${old.id}\nREASON: scripted`)
      const res = await tool('lean', 'plur_admin')!.handler({ action: 'plur_learn_batch', args: { engrams: [{ statement: INCOMING, scope: 'global' }] } }, plur) as any
      expect(res.success, JSON.stringify(res).slice(0, 300)).not.toBe(false)
      expect(checker.calls, 'precondition: the duplicate checker was asked').toBeGreaterThan(0)
      const fresh = new Plur({ path: dir })
      expect((await fresh.getById(old.id))?.statement).toBe(OLD)
      const added = (await fresh.list()).find(e => e.statement === INCOMING)
      expect(added, 'the incoming item was saved as its own memory').toBeDefined()
      expect(added!.relations?.related ?? []).toContain(old.id)
    })
  }

  it('plur_report_failure through plur_admin is refused and the procedure keeps its text', async () => {
    const proc = await plur.learn(PROC, { scope: 'global', type: 'procedural' })
    const checker = scriptChecker(() => 'SCRIPTED REWRITE')
    const res = await tool('lean', 'plur_admin')!.handler({
      action: 'plur_report_failure',
      args: { engram_id: proc.id, failure_context: 'image tag gone', llm_base_url: 'http://127.0.0.1:9/v1', llm_api_key: 'test-only' },
    }, plur) as any
    expect(res.success).toBe(false)
    expect(res.error).toContain('plur_report_failure')
    expect(checker.calls).toBe(0)
    expect((await plur.getById(proc.id))?.statement).toBe(PROC)
  })

  it('plur_report_failure called directly still does what it did (behaviour unchanged)', async () => {
    const proc = await plur.learn(PROC, { scope: 'global', type: 'procedural' })
    scriptChecker(() => 'SCRIPTED REWRITE of the rollback procedure')
    const direct = tool('lean', 'plur_report_failure')!
    await direct.handler({ engram_id: proc.id, failure_context: 'image tag gone', llm_base_url: 'http://127.0.0.1:9/v1', llm_api_key: 'test-only' }, plur)
    expect((await new Plur({ path: dir }).getById(proc.id))?.statement).toBe('SCRIPTED REWRITE of the rollback procedure')
  })
})
