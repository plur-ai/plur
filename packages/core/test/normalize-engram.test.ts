/**
 * #877 — field-compatibility rules must hold at EVERY loader.
 *
 * Three code paths turn stored data into an `Engram`, and each used to
 * normalise independently. A miss is silent: Zod fills the schema default and
 * the result is indistinguishable from a real value. #875's
 * `reference_count` → `write_count` rename recurred exactly this way — the
 * backfill landed in the YAML loader only, so on the Postgres tier a legacy row
 * loaded as `write_count: 1` while `reference_count: 5` sat unread under
 * passthrough. `write_count` gates retirement, so one `forget()` would have
 * retired an engram with five corroborating writes.
 *
 * So the rules are tested twice over: once as pure functions, and once THROUGH
 * each loader. The second half is the part that matters — it is what fails when
 * a fourth backend skips the set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { normalizeEngramInput, RULES } from '../src/normalize-engram.js'
import { parseEngramFile } from '../src/engrams.js'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { RemoteStore } from '../src/store/remote-store.js'
import type { Engram } from '../src/schemas/engram.js'

/** A complete, schema-valid engram carrying the PRE-#866 field name. */
function legacyEngram(id: string): Record<string, unknown> {
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', visibility: 'private',
    statement: 'a legacy engram with five corroborating writes',
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-10' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null, content_hash: `h-${id}`,
    commitment: 'leaning', recurrence_count: 0, summary: 's', engram_version: 1,
    episode_ids: [], sources: [],
    // The whole point: the OLD name, with a value a default would mask.
    reference_count: 5,
  }
}

describe('normalizeEngramInput — rule semantics (#877)', () => {
  it('migrates reference_count to write_count and strips the old key', () => {
    const out = normalizeEngramInput({ id: 'ENG-1', reference_count: 5 }) as Record<string, unknown>
    expect(out.write_count).toBe(5)
    expect('reference_count' in out).toBe(false)
  })

  it('is idempotent — a migrated record is untouched, by reference', () => {
    const already = { id: 'ENG-1', write_count: 5 }
    expect(normalizeEngramInput(already)).toBe(already)
  })

  it('does not clobber a new-format value when a stale old key rides alongside', () => {
    // Order matters here: if the rule keyed on the OLD name being present it
    // would overwrite a correct value with a stale one.
    const out = normalizeEngramInput({ id: 'ENG-1', write_count: 9, reference_count: 5 }) as Record<string, unknown>
    expect(out.write_count).toBe(9)
  })

  it('never mutates its input', () => {
    const input = { id: 'ENG-1', reference_count: 5 }
    normalizeEngramInput(input)
    expect(input).toEqual({ id: 'ENG-1', reference_count: 5 })
  })

  it('passes non-objects through untouched', () => {
    for (const v of [null, undefined, 42, 'str', ['a']]) expect(normalizeEngramInput(v)).toBe(v)
  })

  it('has at least one rule, and every rule is self-describing', () => {
    // An emptied RULES array would make every loader test below vacuous.
    expect(RULES.length).toBeGreaterThan(0)
    for (const r of RULES) {
      expect(r.id, 'each rule names the issue that introduced it').toMatch(/^#\d+$/)
      expect(r.description.length).toBeGreaterThan(10)
    }
  })
})

/**
 * The anti-regression half. Each loader gets the SAME legacy record and must
 * produce the same normalised result — so adding a backend that forgets to call
 * `normalizeEngramInput` fails here rather than silently losing data in
 * production.
 */
describe('every loader applies the rules (#877)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-norm-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('YAML loader (parseEngramFile)', () => {
    const content = yaml.dump({ engrams: [legacyEngram('ENG-YAML-1')] })
    const { valid, quarantined } = parseEngramFile(join(dir, 'engrams.yaml'), content, content.length)
    expect(quarantined).toHaveLength(0)
    expect(valid).toHaveLength(1)
    expect((valid[0] as any).write_count).toBe(5)
    expect('reference_count' in (valid[0] as any)).toBe(false)
  })

  it('Postgres/PGLite loader (parseRow)', async () => {
    // The row has to be written with the LEGACY key still in its JSONB, which
    // means bypassing syncFromYaml — that path reads through the YAML loader,
    // which normalises, so a row seeded that way can never exercise parseRow's
    // own normalisation. (An earlier version of this test did exactly that and
    // passed with the fix reverted: it proved nothing.)
    const yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, yaml.dump({ engrams: [] }))
    const adapter = new PGLiteAdapter(yamlPath, join(dir, 'idx'))
    await adapter.syncFromYaml()   // initialises the schema

    const legacy = legacyEngram('ENG-PG-1')
    // Deliberate reach into the private handle: there is no public write path
    // that preserves an un-normalised row, and the WIRING is what this asserts.
    const db = (adapter as unknown as { db: { query: (sql: string, params?: unknown[]) => Promise<unknown> } }).db
    await db.query(
      `INSERT INTO engrams (id, status, scope, domain, last_accessed, data, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      ['ENG-PG-1', 'active', 'global', null, '2026-08-10', JSON.stringify(legacy)],
    )

    const loaded = await adapter.loadFiltered({})
    const found = loaded.find(e => e.id === 'ENG-PG-1')
    expect(found, 'row did not come back from the index').toBeDefined()
    // Without normalisation in parseRow this is 1 (the Zod default) while
    // reference_count: 5 sits unread under passthrough — and write_count gates
    // retirement, so one forget() would retire a five-write engram.
    expect((found as any).write_count).toBe(5)
    expect('reference_count' in (found as any)).toBe(false)
  }, 120_000)

  it('remote-row loader (RemoteStore.reshape, via load)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({
        rows: [{
          id: 'ENG-REMOTE-1', scope: 'group:test', status: 'active',
          data: legacyEngram('ENG-REMOTE-1'),
        }],
        total_count: 1,
      }),
      text: async () => '',
    })) as any
    try {
      const store = new RemoteStore('https://example.test/sse', 'tok', 'group:test', { ttlMs: 0 })
      const engrams = await store.load()
      expect(engrams).toHaveLength(1)
      expect((engrams[0] as any).write_count).toBe(5)
      expect('reference_count' in (engrams[0] as any)).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })
})
