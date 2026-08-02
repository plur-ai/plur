/**
 * plur.rescope() (#676) — move an existing engram to a different scope.
 *
 * Covers the accepted design constraints from the issue thread:
 *  1. content-hash dedup must not intercept a rescope (match by id, move)
 *  2. atomic semantics — on partial/remote failure the source stays intact
 *  3. batch support (`ids: string[]`) first-class
 *  4. target-store validation — unknown scope fails early, structured error
 *  5. dedup on target — identical engram already there = idempotent success
 *
 * Plus: local in-place rescope preserves id/activation, the retired source
 * cannot be resurrected via its content hash, sensitivity guard blocks a
 * promote to a shared scope, and dry_run mutates nothing (local or remote).
 *
 * Remote legs run against the in-process StubServer (real HTTP, real wire
 * shapes) — the same harness as remote-integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'rescope-test-token'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => {
  await server.stop()
})

function writeConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }),
  )
}

function readLocalEngrams(dir: string): any[] {
  const path = join(dir, 'engrams.yaml')
  if (!existsSync(path)) return []
  const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

function readHistoryEvents(dir: string): any[] {
  const historyDir = join(dir, 'history')
  if (!existsSync(historyDir)) return []
  const events: any[] = []
  for (const f of readdirSync(historyDir).filter((f: string) => f.endsWith('.jsonl'))) {
    const lines = readFileSync(join(historyDir, f), 'utf-8').split('\n').filter(l => l.trim())
    for (const line of lines) events.push(JSON.parse(line))
  }
  return events
}

describe('rescope — local route (in-place scope rewrite)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rescope-local-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('rewrites scope in place, preserving id, activation and feedback', async () => {
    const e = await plur.learn('Prefer explicit return types on exported functions', { scope: 'project:alpha' })
    // Accumulate activation state that a move must not reset.
    await plur.feedback(e.id, 'positive')
    await plur.feedback(e.id, 'positive')
    const before = (await plur.getById(e.id))!
    expect(before.feedback_signals.positive).toBe(2)
    const strengthBefore = before.activation.retrieval_strength
    expect(strengthBefore).not.toBe(0.7) // feedback actually moved it

    const { results, success } = await plur.rescope(e.id, 'global')
    expect(success).toBe(true)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: e.id, status: 'rescoped', action: 'local_rewrite',
      from_scope: 'project:alpha', to_scope: 'global', new_id: e.id,
    })

    const after = (await plur.getById(e.id))!
    expect(after.id).toBe(e.id)                       // same row — not a copy
    expect(after.scope).toBe('global')
    expect(after.status).toBe('active')
    expect(after.activation.retrieval_strength).toBe(strengthBefore)
    expect(after.feedback_signals.positive).toBe(2)
    expect((after as any).structured_data._rescoped).toMatchObject({ from_scope: 'project:alpha' })

    // Audited through the normal history mechanism.
    const events = readHistoryEvents(dir)
    const rescoped = events.filter(ev => ev.event === 'engram_rescoped' && ev.engram_id === e.id)
    expect(rescoped).toHaveLength(1)
    expect(rescoped[0].data).toMatchObject({ from_scope: 'project:alpha', to_scope: 'global', routed_to: 'local' })
  })

  it('same-scope rescope is a noop, retired source is an error, unknown id is an error', async () => {
    const e = await plur.learn('Noop test statement', { scope: 'global' })
    const noop = await plur.rescope(e.id, 'global')
    expect(noop.results[0].status).toBe('noop')
    expect(noop.success).toBe(true)

    await plur.forget(e.id)
    const retired = await plur.rescope(e.id, 'local')
    expect(retired.results[0].status).toBe('error')
    expect(retired.results[0].error).toMatch(/retired/)
    expect(retired.success).toBe(false)

    const missing = await plur.rescope('ENG-9999-0101-999', 'global')
    expect(missing.results[0].status).toBe('error')
    expect(missing.results[0].error).toMatch(/not found/i)
  })

  it('dedup on target (constraint 5): identical engram already at the target is idempotent success', async () => {
    const e = await plur.learn('Duplicate collapse statement', { scope: 'project:alpha' })
    // Handcraft an identical active engram already living at the target scope
    // (learn() can't create it — its cross-scope recurrence path would intercept).
    const path = join(dir, 'engrams.yaml')
    const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams: any[] }
    const src = data.engrams.find(r => r.id === e.id)
    data.engrams.push({ ...structuredClone(src), id: 'ENG-2020-0101-001', scope: 'global' })
    writeFileSync(path, yaml.dump(data, { lineWidth: 120, noRefs: true }))

    const plur2 = new Plur({ path: dir })
    const { results, success } = await plur2.rescope(e.id, 'global')
    expect(success).toBe(true)
    expect(results[0]).toMatchObject({ id: e.id, status: 'deduped', new_id: 'ENG-2020-0101-001' })

    // The pair collapsed: source retired with a superseded_by link, target untouched.
    const rows = readLocalEngrams(dir)
    const srcRow = rows.find(r => r.id === e.id)
    const dupRow = rows.find(r => r.id === 'ENG-2020-0101-001')
    expect(srcRow.status).toBe('retired')
    expect(srcRow.relations.superseded_by).toContain('ENG-2020-0101-001')
    expect(dupRow.status).toBe('active')
    expect(dupRow.scope).toBe('global')
  })

  it('batch (constraint 3): per-id outcomes, one failure never blocks the rest', async () => {
    const a = await plur.learn('Batch statement alpha', { scope: 'project:alpha' })
    const b = await plur.learn('Batch statement beta', { scope: 'project:alpha' })
    const { results, success } = await plur.rescope([a.id, 'ENG-0000-0000-000', b.id], 'global')
    expect(success).toBe(false)
    expect(results.map(r => r.status)).toEqual(['rescoped', 'error', 'rescoped'])
    expect((await plur.getById(a.id))!.scope).toBe('global')
    expect((await plur.getById(b.id))!.scope).toBe('global')
  })

  it('dry_run mutates nothing on the local route', async () => {
    const e = await plur.learn('Dry run local statement', { scope: 'project:alpha' })
    const yamlBefore = readFileSync(join(dir, 'engrams.yaml'), 'utf-8')

    const { results, success } = await plur.rescope(e.id, 'global', { dry_run: true })
    expect(success).toBe(true)
    expect(results[0]).toMatchObject({ id: e.id, status: 'rescoped', dry_run: true, to_scope: 'global' })

    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf-8')).toBe(yamlBefore)
    expect((await plur.getById(e.id))!.scope).toBe('project:alpha')
  })

  it('fails early on a target scope with no configured store (constraint 4 — the typo case)', async () => {
    const e = await plur.learn('Typo scope statement', { scope: 'local' })
    await expect(plur.rescope(e.id, 'group:plur-ai/engineering')).rejects.toThrow(/no configured store matches/)
    // Nothing changed.
    expect((await plur.getById(e.id))!.scope).toBe('local')
  })
})

describe('rescope — remote route (StubServer)', () => {
  let dir: string

  beforeEach(() => {
    server.reset()
    dir = mkdtempSync(join(tmpdir(), 'plur-rescope-remote-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function remotePlur(token = TOKEN, extra: Record<string, unknown> = {}): Plur {
    writeConfig(dir, [{ url: baseUrl, token, scope: 'group:test', shared: true, readonly: false, ...extra }])
    return new Plur({ path: dir })
  }

  it('pushes the copy over the wire (statement/scope/domain/type/source provenance), retires the local source with a superseded_by link, and no dup injection remains', async () => {
    const plur = remotePlur()
    const e = await plur.learn('Team convention: always run vitest before pushing', {
      scope: 'local', domain: 'plur.testing', type: 'procedural',
    })

    const { results, success } = await plur.rescope(e.id, 'group:test')
    expect(success).toBe(true)
    expect(results[0]).toMatchObject({
      id: e.id, status: 'rescoped', action: 'remote_push',
      from_scope: 'local', to_scope: 'group:test',
      new_id: 'ENG-SRV-001', kept_local: false,
    })

    // Wire shape: the server-side copy carries the rewritten scope plus the
    // statement/domain/type and the provenance-bearing source field.
    expect(server.engramCount).toBe(1)
    const pushed = server.getEngram('ENG-SRV-001')!
    expect(pushed.scope).toBe('group:test')
    expect(pushed.status).toBe('active')
    expect(pushed.data.statement).toBe('Team convention: always run vitest before pushing')
    expect(pushed.data.domain).toBe('plur.testing')
    expect(pushed.data.type).toBe('procedural')
    expect(pushed.data.source).toContain(`rescoped from ${e.id} (local)`)

    // Local source: soft-retired with the supersedes-style link.
    const rows = readLocalEngrams(dir)
    const srcRow = rows.find(r => r.id === e.id)
    expect(srcRow.status).toBe('retired')
    expect(srcRow.relations.superseded_by).toContain('ENG-SRV-001')
    expect(srcRow.structured_data._rescoped).toMatchObject({ to_scope: 'group:test', to_id: 'ENG-SRV-001' })

    // No dup injection: only the team copy is active — the retired source is
    // invisible to list()/inject() status filters.
    const active = await plur.list()
    expect(active.find(x => x.id === e.id)).toBeUndefined()
    const copies = active.filter(x => x.statement === 'Team convention: always run vitest before pushing')
    expect(copies).toHaveLength(1)
    expect(copies[0].scope).toBe('group:test')
  })

  it('the retired source cannot be resurrected via its content hash', async () => {
    const plur = remotePlur()
    const stmt = 'Hash resurrection guard statement'
    const e = await plur.learn(stmt, { scope: 'local' })
    await plur.rescope(e.id, 'group:test')

    // Fresh instance (cold remote cache): re-learning the same statement in the
    // same scope must NOT return the retired row — _hashDedup only matches
    // active engrams, so this is a fresh engram.
    const plur2 = new Plur({ path: dir })
    const relearned = await plur2.learn(stmt, { scope: 'local' })
    expect(relearned.id).not.toBe(e.id)
    expect(relearned.status).toBe('active')
    const srcRow = readLocalEngrams(dir).find(r => r.id === e.id)
    expect(srcRow.status).toBe('retired')
  })

  it('keep_local: true keeps the local original active after the push', async () => {
    const plur = remotePlur()
    const e = await plur.learn('Keep local original statement', { scope: 'local' })
    const { results } = await plur.rescope(e.id, 'group:test', { keep_local: true })
    expect(results[0]).toMatchObject({ status: 'rescoped', kept_local: true, new_id: 'ENG-SRV-001' })
    expect(server.engramCount).toBe(1)

    const srcRow = readLocalEngrams(dir).find(r => r.id === e.id)
    expect(srcRow.status).toBe('active')
    expect(srcRow.scope).toBe('local')
    expect(srcRow.relations?.superseded_by ?? []).toEqual([])
  })

  it('authorization denied (401) fails loud and leaves the source untouched — no outbox, no retire (constraint 2)', async () => {
    const plur = remotePlur('wrong-token')
    const e = await plur.learn('Auth denied statement', { scope: 'local' })
    const yamlBefore = readFileSync(join(dir, 'engrams.yaml'), 'utf-8')

    const { results, success } = await plur.rescope(e.id, 'group:test')
    expect(success).toBe(false)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toMatch(/Remote push failed/)
    expect(results[0].error).toMatch(/401/)
    expect(results[0].error).toMatch(/re-authenticate/)

    // Atomic: nothing landed, nothing changed locally, nothing queued.
    expect(server.engramCount).toBe(0)
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf-8')).toBe(yamlBefore)
    const srcRow = readLocalEngrams(dir).find(r => r.id === e.id)
    expect(srcRow.status).toBe('active')
    expect(srcRow.structured_data?._outbox).toBeUndefined()
  })

  it('readonly store entry is refused up-front (authorization, learnRouted parity)', async () => {
    writeConfig(dir, [{ url: baseUrl, token: TOKEN, scope: 'group:test', shared: true, readonly: true }])
    const plur = new Plur({ path: dir })
    const e = await plur.learn('Readonly target statement', { scope: 'local' })
    await expect(plur.rescope(e.id, 'group:test')).rejects.toThrow(/readonly/)
    expect(server.engramCount).toBe(0)
    expect((await plur.getById(e.id))!.scope).toBe('local')
  })

  it('secrets/sensitivity guard blocks a promote to a shared scope (full-content re-scan)', async () => {
    const plur = remotePlur()
    // Infra-sensitive content is legitimate in a local scope (learn accepts it)
    // but must not cross into a shared/remote store on an explicit rescope.
    const e = await plur.learn('Staging DB listens on 10.0.0.5:5432 behind the bastion', { scope: 'local' })
    expect((await plur.getById(e.id))!.scope).toBe('local')

    const { results, success } = await plur.rescope(e.id, 'group:test')
    expect(success).toBe(false)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toMatch(/sensitive content/)

    // Blocked means blocked: nothing pushed, source untouched and still active.
    expect(server.engramCount).toBe(0)
    const srcRow = readLocalEngrams(dir).find(r => r.id === e.id)
    expect(srcRow.status).toBe('active')
    expect(srcRow.scope).toBe('local')
  })

  it('sensitive content hiding in context fields (not the statement) is caught too', async () => {
    const plur = remotePlur()
    const e = await plur.learn('Connect to the staging database first', {
      scope: 'local', rationale: 'the box lives at 192.168.4.20:6432',
    })
    const { results } = await plur.rescope(e.id, 'group:test')
    expect(results[0].status).toBe('error')
    expect(results[0].error).toMatch(/sensitive content/)
    expect(server.engramCount).toBe(0)
  })

  it('dry_run mutates nothing on the remote route — no POST, no retire', async () => {
    const plur = remotePlur()
    const e = await plur.learn('Dry run remote statement', { scope: 'local' })
    const yamlBefore = readFileSync(join(dir, 'engrams.yaml'), 'utf-8')

    const { results, success } = await plur.rescope(e.id, 'group:test', { dry_run: true })
    expect(success).toBe(true)
    expect(results[0]).toMatchObject({
      id: e.id, status: 'rescoped', action: 'remote_push',
      to_scope: 'group:test', dry_run: true,
    })

    expect(server.engramCount).toBe(0)
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf-8')).toBe(yamlBefore)
  })

  it('batch remote promote — the 35-engram use case in miniature', async () => {
    const plur = remotePlur()
    const a = await plur.learn('Team fact one for the batch', { scope: 'local' })
    const b = await plur.learn('Team fact two for the batch', { scope: 'local' })
    const c = await plur.learn('Team fact three for the batch', { scope: 'local' })

    const { results, success } = await plur.rescope([a.id, b.id, c.id], 'group:test')
    expect(success).toBe(true)
    expect(results.map(r => r.status)).toEqual(['rescoped', 'rescoped', 'rescoped'])
    expect(new Set(results.map(r => r.new_id)).size).toBe(3) // three server ids
    expect(server.engramCount).toBe(3)

    const rows = readLocalEngrams(dir)
    for (const id of [a.id, b.id, c.id]) {
      expect(rows.find(r => r.id === id).status).toBe('retired')
    }
  })
})
