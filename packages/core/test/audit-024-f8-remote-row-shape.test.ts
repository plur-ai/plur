/**
 * Security audit 2026-11 (finding 8): a team-store row is semi-trusted input.
 * Nested array/object fields that later code iterates or dereferences
 * (knowledge_anchors, entities, tags, relations, associations, sources,
 * feedback_signals, structured_data, …) must be normalised where remote rows
 * enter, so one malformed row cannot make recall or injection throw for every
 * reader of the scope. Malformed ITEMS are dropped; the row itself stays.
 *
 * Both remote legs are covered: the url-store cache (GET /engrams, warmed) and
 * the live recall leg (POST /recall).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur, salvageRemoteRow } from '../src/index.js'

const SCOPE = 'group:acme/eng'
const STATEMENT = 'release checklist must gate on the canary suite'
const QUERY = 'release checklist canary'
const dirs: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A Plur whose one url store serves `extra` on the chosen leg only. */
function storeWith(extra: Record<string, unknown>, leg: 'cache' | 'live'): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-f8-shape-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nindex: false\n` +
    `stores:\n  - url: https://team.example.invalid\n    token: dummy-token\n    scope: "${SCOPE}"\n    shared: true\n`)
  const id = 'ENG-2026-11-01-100'
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/recall')) {
      return json({ results: leg === 'live' ? [{ id, scope: SCOPE, status: 'active', statement: STATEMENT, score: 1, ...extra }] : [] })
    }
    if (url.includes('/engrams')) {
      const rows = leg === 'cache' ? [{ id, scope: SCOPE, status: 'active', data: { statement: STATEMENT, ...extra } }] : []
      return json({ rows, total_count: rows.length })
    }
    return json({}, 404)
  }))
  return new Plur({ path: dir })
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ['well-formed control', {}],
  ['knowledge_anchors [null]', { knowledge_anchors: [null] }],
  ['knowledge_anchors non-iterable', { knowledge_anchors: { length: 1 } }],
  ['entities [null]', { entities: [null] }],
  ['entities non-iterable', { entities: 5 }],
  ['tags [null]', { tags: [null, 7] }],
  ['associations [null]', { associations: [null] }],
  ['relations with non-array members', { relations: { related: 5, conflicts: [null], supersedes: 'x' } }],
  ['feedback_signals non-object', { feedback_signals: 'lots' }],
  ['structured_data non-object', { structured_data: [null] }],
]

describe('remote rows are normalised at the client boundary (audit finding 8)', () => {
  for (const leg of ['cache', 'live'] as const) {
    for (const [name, extra] of CASES) {
      it(`${leg} leg: ${name} — recall and injection still work and keep the row`, async () => {
        const plur = storeWith(extra, leg)
        if (leg === 'cache') await plur.warmRemoteCaches()
        const recalled = await plur.recall(QUERY, { scope: 'project:acme/app' })
        expect(recalled.map(e => e.statement)).toContain(STATEMENT)
        const hybrid = await plur.recallHybrid(QUERY, { scope: 'project:acme/app' })
        expect(hybrid.map(e => e.statement)).toContain(STATEMENT)
        const injected: any = await plur.injectHybrid(QUERY, { scope: 'project:acme/app' })
        expect(injected.count).toBeGreaterThanOrEqual(1)
        // plain inject reads the cached corpus only; it never dials the live leg
        if (leg === 'cache') {
          const plain: any = await plur.inject(QUERY, { scope: 'project:acme/app' })
          expect(plain.count).toBeGreaterThanOrEqual(1)
        }
      })
    }
  }

  it('drops malformed items but keeps well-formed ones', () => {
    const out = salvageRemoteRow({
      id: 'ENG-2026-11-01-101', scope: SCOPE, status: 'active', statement: STATEMENT,
      knowledge_anchors: [null, 'x', { path: 'docs/a.md', snippet: 'canary gate' }, { path: 'docs/b.md', snippet: 5 }],
      entities: [null, { name: 'canary', type: 'tool' }, { type: 'tool' }],
      tags: ['release', null, 3],
      contraindications: ['on a hotfix', null],
      relations: { related: ['ENG-1', null], conflicts: 'x' },
      feedback_signals: 'lots',
    })
    expect(out).not.toBeNull()
    const d = out!.data as any
    expect(d.statement).toBe(STATEMENT)
    expect(d.knowledge_anchors).toEqual([{ path: 'docs/a.md', snippet: 'canary gate' }])
    expect(d.entities).toEqual([{ name: 'canary', type: 'tool' }])
    expect(d.tags).toEqual(['release'])
    expect(d.contraindications).toEqual(['on a hotfix'])
    expect(d.relations).toEqual({ related: ['ENG-1'] })
    expect(d.feedback_signals).toBeUndefined()
  })
})
