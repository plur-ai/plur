// FGT-2: One explicit forget removes a memory even if it was saved several times.
//
// "Explicit forget" is the forget a user makes: the CLI (`plur forget`) and the
// MCP tool (plur_forget). The first case calls core with force, as both of
// those do. The other two drive the CLI and the MCP tool themselves, without
// passing any force flag, so a surface that stops passing force is caught
// (audit B-01 sibling).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, useEmbedder, type TempStore } from '../helpers/store.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { hookHome, runSource, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

const SAID = 'The staging cluster is rebuilt every Sunday night'

describe('FGT-2 one explicit forget removes a memory saved several times', () => {
  let s: TempStore | undefined
  let m: McpSession | undefined
  let h: HookHome | undefined
  afterEach(async () => { s?.cleanup(); s = undefined; await m?.close(); m = undefined; h?.cleanup(); h = undefined })

  it('saved three times, forgotten once (core, with force as the surfaces pass it)', async () => {
    s = await tempStore({ embedder: 'off' })
    const a = await s.plur.learn(SAID, { scope: 'global' })
    const b = await s.plur.learn(SAID, { scope: 'global' })
    const c = await s.plur.learn(SAID, { scope: 'global' })
    expect([b.id, c.id], 'precondition: the repeats landed on one memory').toEqual([a.id, a.id])
    const before = await s.plur.getById(a.id)
    expect(before?.write_count, `precondition: the memory records it was saved 3 times; it says ${before?.write_count}`).toBe(3)

    const foundBefore = (await s.plur.recall('staging cluster rebuilt Sunday', { limit: 10 })).map(e => e.id)
    expect(foundBefore, 'precondition: search finds the memory before the forget').toContain(a.id)
    const injectedBefore = await s.plur.inject('rebuild the staging cluster')
    expect(injectedBefore.injected_ids, 'precondition: the agent is given the memory before the forget').toContain(a.id)

    await s.plur.forget(a.id, 'eval: no longer true', { force: true })

    const after = await s.plur.getById(a.id)
    expect(after?.status, `expected the memory to be gone after one forget; its status is ${after?.status}`).toBe('retired')
    const found = (await s.plur.recall('staging cluster rebuilt Sunday', { limit: 10 })).map(e => e.id)
    expect(found, `search still returns the memory after one forget: ${JSON.stringify(found)}`).not.toContain(a.id)
    const injected = await s.plur.inject('rebuild the staging cluster')
    expect(injected.injected_ids, 'the agent is still given the memory after one forget').not.toContain(a.id)
  })

  it('saved three times, forgotten once through the MCP plur_forget tool (no force flag passed)', async () => {
    useEmbedder('off')
    m = await mcpSession({ profile: 'full' })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = await m.call('plur_learn', { statement: SAID, scope: 'global' })
      expect(res.isError, `plur_learn failed: ${res.text}`).toBe(false)
      ids.push(res.json?.id)
    }
    expect(ids, `precondition: the three saves landed on one memory (${JSON.stringify(ids)})`).toEqual([ids[0], ids[0], ids[0]])
    const id = ids[0]
    expect((await m.plur.getById(id))?.write_count, 'precondition: the memory records it was saved 3 times').toBe(3)
    const before = await m.call('plur_recall', { query: 'staging cluster rebuilt Sunday', mode: 'keyword', limit: 10 })
    expect((before.json?.results ?? []).map((r: any) => r.id), 'precondition: plur_recall finds the memory before the forget').toContain(id)

    const res = await m.call('plur_forget', { id, reason: 'eval: no longer true' })
    expect(res.isError, `plur_forget failed: ${res.text}`).toBe(false)

    const after = await m.plur.getById(id)
    expect(after?.status, `after one plur_forget the memory should be gone; its status is ${after?.status} (saved count now ${after?.write_count})`).toBe('retired')
    const found = await m.call('plur_recall', { query: 'staging cluster rebuilt Sunday', mode: 'keyword', limit: 10 })
    expect((found.json?.results ?? []).map((r: any) => r.id), 'plur_recall still returns the memory after one plur_forget').not.toContain(id)
    const injected = await m.call('plur_inject', { task: 'rebuild the staging cluster' })
    expect(injected.json?.injected_ids ?? [], 'plur_inject still gives the memory after one plur_forget').not.toContain(id)
  })

  it('saved three times, forgotten once through the CLI `plur forget` (no --force)', async () => {
    h = hookHome()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = runSource('cli', ['learn', SAID, '--scope', 'global', '--json'], { env: h.env, cwd: h.home })
      expect(r.status, `plur learn failed: ${r.stderr}`).toBe(0)
      ids.push(JSON.parse(r.stdout).id)
    }
    expect(ids, `precondition: the three saves landed on one memory (${JSON.stringify(ids)})`).toEqual([ids[0], ids[0], ids[0]])
    const id = ids[0]
    const store = () => { const p = new Plur({ path: join(h!.home, '.plur'), autoDiscover: false }); return p.ready().then(() => p) }
    expect((await (await store()).getById(id))?.write_count, 'precondition: the memory records it was saved 3 times').toBe(3)

    const rb = runSource('cli', ['recall', 'staging cluster rebuilt Sunday', '--json'], { env: h.env, cwd: h.home })
    expect(rb.status, `precondition: plur recall works before the forget: ${rb.stderr}`).toBe(0)
    expect(rb.stdout, 'precondition: `plur recall` finds the memory before the forget').toContain(id)

    const f = runSource('cli', ['forget', id, '--reason', 'eval: no longer true'], { env: h.env, cwd: h.home })
    expect(f.status, `plur forget failed: ${f.stderr}`).toBe(0)

    const after = await (await store()).getById(id)
    expect(after?.status, `after one \`plur forget\` the memory should be gone; its status is ${after?.status} (saved count now ${after?.write_count})`).toBe('retired')
    const r = runSource('cli', ['recall', 'staging cluster rebuilt Sunday', '--json'], { env: h.env, cwd: h.home })
    // Exit 2 is the CLI's documented "no results found".
    expect([0, 2], `plur recall failed (exit ${r.status}): ${r.stderr}`).toContain(r.status)
    expect(r.stdout, '`plur recall` still returns the memory after one `plur forget`').not.toContain(id)
  }, 120_000)
})
