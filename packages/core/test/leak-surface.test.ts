/**
 * The leak guard scans one surface, defined once (#1002 review).
 *
 * `LearnContext` said what a caller may write; a hand-kept list in
 * `_engramContextFields` said what the engram-side guards (explicit update,
 * rescope, outbox flush, meta save) look at. Nothing tied them together, and
 * the provenance work added `attribution`, `claim_class` and `license` to the
 * first and not the second. Reproduced on the PR head:
 *
 *   learn('benign', { scope: 'local', attribution: { asserted_by: 'AKIA…' },
 *                     license: 'postgres://u:p@db.internal/x' })   → ok
 *   rescope([id], 'project:acme')                                  → rescoped
 *
 * The key and the connection string then sat at a shared scope, where the
 * same key in `tags` was refused. These tests hold the surface in place from
 * three directions: the table that classifies every `LearnContext` field, the
 * two engram constructors that have to put each field somewhere the scan can
 * see, and every write path that can move content into a shared scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import {
  LEARN_CONTEXT_FIELD_ROLES,
  LEARN_CONTENT_FIELDS,
  engramContentFields,
  learnContextContent,
} from '../src/content-fields.js'
import type { LearnContext } from '../src/types.js'
import type { Engram } from '../src/schemas/engram.js'

const AWS = 'AKIAIOSFODNN7EXAMPLE'
const CONN = 'postgres://u:p@db.internal:5432/x'
/** An infra-class value: not a credential, so the hard scan lets it into a local store. */
const INTERNAL = 'bastion.internal'

/**
 * A context carrying `value` in ONE content field, shaped the way that field
 * is shaped. Every field the table calls content must be constructible here,
 * or a new one would be silently untested.
 */
function contextWith(field: keyof LearnContext, value: string): LearnContext {
  const context: LearnContext = {}
  switch (field) {
    case 'tags': context.tags = [value]; break
    case 'knowledge_anchors': context.knowledge_anchors = [{ path: value, snippet: value }]; break
    case 'dual_coding': context.dual_coding = { example: value }; break
    case 'attribution': context.attribution = { asserted_by: value, model: { name: 'm', prompt_id: value } }; break
    case 'measured_under': context.measured_under = { model: value }; break
    case 'supersedes': context.supersedes = [value]; break
    // Only stored when the engram is locked.
    case 'locked_reason': context.commitment = 'locked'; context.locked_reason = value; break
    default: (context as Record<string, unknown>)[field] = value
  }
  return context
}

/** A context with a distinctive, harmless canary in EVERY content field. */
function canaryContext(mark: string): { context: LearnContext; canaries: Record<string, string> } {
  const canaries: Record<string, string> = {}
  let context: LearnContext = {}
  for (const field of LEARN_CONTENT_FIELDS) {
    const v = `${mark}-${field}-7f3a`
    canaries[field] = v
    context = { ...context, ...contextWith(field, v) }
  }
  return { context, canaries }
}

function readRows(dir: string): any[] {
  const data = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

describe('the table that defines the scan surface', () => {
  it('classifies the fields #1002 added as content', () => {
    for (const field of ['attribution', 'claim_class', 'license'] as const) {
      expect(LEARN_CONTEXT_FIELD_ROLES[field], field).toBe('content')
    }
  })

  it('classifies every field as exactly content or control', () => {
    // The compiler already enforces that every key of LearnContext has a row
    // (`satisfies Record<keyof LearnContext, …>`); this guards the values.
    for (const [field, role] of Object.entries(LEARN_CONTEXT_FIELD_ROLES)) {
      expect(['content', 'control'], field).toContain(role)
    }
    expect(LEARN_CONTENT_FIELDS.length).toBeGreaterThan(10)
  })

  it('learnContextContent picks exactly the content fields', () => {
    const { context, canaries } = canaryContext('pick')
    const picked = learnContextContent({ ...context, scope: 'group:x', type: 'behavioral' })!
    for (const field of LEARN_CONTENT_FIELDS) expect(JSON.stringify(picked[field]), field).toContain(canaries[field])
    expect(picked.scope).toBeUndefined()
    expect(picked.type).toBeUndefined()
    expect(learnContextContent(undefined)).toBeUndefined()
    expect(learnContextContent({ scope: 'local' })).toBeUndefined()
  })
})

describe('both engram constructors put every content field where the scan reads it', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-surface-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('learn()', async () => {
    const { context, canaries } = canaryContext('learn')
    const e = await plur.learn('canary statement one', { ...context, scope: 'local' })
    const seen = JSON.stringify(engramContentFields(e))
    for (const [field, v] of Object.entries(canaries)) expect(seen, field).toContain(v)
  })

  it('_buildEngramShape (the remote-routed constructor)', () => {
    const { context, canaries } = canaryContext('shape')
    const shape = (plur as any)._buildEngramShape('canary statement two', 'local', context, new Date().toISOString()) as Engram
    const seen = JSON.stringify(engramContentFields(shape))
    for (const [field, v] of Object.entries(canaries)) expect(seen, field).toContain(v)
  })

  it('the two constructors agree on the shape they produce', async () => {
    // Same context through both. Identifiers and timestamps differ by
    // construction; the key set and every content field must not.
    const { context } = canaryContext('same')
    const now = new Date().toISOString()
    const learned = await plur.learn('the same statement', { ...context, scope: 'local' })
    const shaped = (plur as any)._buildEngramShape('the same statement', 'local', context, now) as Engram
    const keys = (e: Engram) => Object.keys(e).filter(k => (e as any)[k] !== undefined).sort()
    expect(keys(shaped)).toEqual(keys(learned))

    const content = (e: Engram) => {
      const f = { ...engramContentFields(e) } as Record<string, any>
      // Bookkeeping that legitimately differs between a persisted engram and a
      // not-yet-persisted shape.
      for (const k of ['id', 'sources', 'activation', 'temporal', 'locked_at']) delete f[k]
      return f
    }
    expect(content(shaped)).toEqual(content(learned))
  })

  it('the engram-side scan strips only PLUR bookkeeping keys, and keeps user structured_data', () => {
    const fields = engramContentFields({
      id: 'ENG-1', statement: 'x', scope: 'local',
      structured_data: { _outbox: { target_url: 'http://127.0.0.1:1' }, note: 'kept' },
    } as unknown as Engram)!
    expect(fields.structured_data).toEqual({ note: 'kept' })
    expect(fields.statement).toBeUndefined()
    expect(fields.scope).toBe('local')
  })
})

describe('the write-time hard scan reads every content field', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hard-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it.each(LEARN_CONTENT_FIELDS)('refuses a credential in %s, even at a local scope', async field => {
    await expect(plur.learn('ordinary statement', { ...contextWith(field, AWS), scope: 'local' }))
      .rejects.toThrow(/Secret detected/)
    // Nothing was written.
    expect((await plur.list()).length).toBe(0)
  })

  it('still accepts the same fields with ordinary values', async () => {
    const { context } = canaryContext('ok')
    await expect(plur.learn('ordinary statement', { ...context, scope: 'local' })).resolves.toBeDefined()
  })

  it('learnRouted applies the same scan', async () => {
    await expect(plur.learnRouted('ordinary statement', { scope: 'local', attribution: { asserted_by: AWS } }))
      .rejects.toThrow(/Secret detected/)
  })
})

/**
 * The paths that MOVE content into a shared scope. `project:*` is a shared
 * scope with a local route, so no remote is needed to exercise the guard.
 *
 * Two flavours of value: an infra-class host name, which the hard scan admits
 * to a local store (a local note about your own bastion is legitimate), and a
 * credential, admitted only under `allow_secrets` — set here so the SOFT guard
 * is what is being tested, not the hard one above.
 */
describe('no path moves attribution, licence or claim class into a shared scope unscanned', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-move-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const permissive = () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ allow_secrets: true, index: false }))
    return new Plur({ path: dir })
  }

  describe('rescope refuses', () => {
    it.each([
      ['attribution.asserted_by', { attribution: { asserted_by: AWS } }],
      ['attribution.model.prompt_id', { attribution: { model: { name: 'gpt', prompt_id: `https://svc:hunter2@db.internal/${AWS}` } } }],
      ['license', { license: CONN }],
      // Not `claim_class`: it is an enum, and a row carrying anything else is
      // dropped by the schema on load, so it cannot reach a rescope. The hard
      // scan above still refuses a credential in it at write time.
    ] as Array<[string, Partial<LearnContext>]>)('a credential in %s (allow_secrets on)', async (_label, extra) => {
      const plur = permissive()
      const e = await plur.learn('benign statement', { scope: 'local', visibility: 'public', ...extra })
      const { results, success } = await plur.rescope([e.id], 'project:acme')
      expect(success).toBe(false)
      expect(results[0].status).toBe('error')
      expect(results[0].error).toMatch(/Blocked: sensitive content/)
      // The row is exactly where it was.
      const row = readRows(dir).find(r => r.id === e.id)
      expect(row.scope).toBe('local')
      expect(row.status).toBe('active')
    })

    it('an internal host in attribution (no allow_secrets needed)', async () => {
      const plur = new Plur({ path: dir })
      const e = await plur.learn('benign statement', { scope: 'local', attribution: { asserted_by: INTERNAL } })
      const { results } = await plur.rescope(e.id, 'project:acme')
      expect(results[0].status).toBe('error')
      expect(results[0].error).toMatch(/internal_host/)
    })
  })

  it('updateEngram to a shared scope demotes rather than moving it', async () => {
    const plur = permissive()
    const e = await plur.learn('benign statement', { scope: 'local', attribution: { asserted_by: AWS } })
    expect(await plur.updateEngram({ ...e, scope: 'project:acme', visibility: 'public' })).toBe(true)
    const after = (await plur.getById(e.id))!
    expect(after.scope).toBe('local')
    expect(after.visibility).toBe('private')
  })

  it('updateEngram carrying a fresh credential in license demotes too', async () => {
    const plur = permissive()
    const e = await plur.learn('benign statement', { scope: 'project:acme', visibility: 'public' })
    expect(e.scope).toBe('project:acme')
    await plur.updateEngram({ ...e, provenance: { origin: 'direct', chain: [], signature: null, license: CONN } })
    expect((await plur.getById(e.id))!.scope).toBe('local')
  })

  it('learnRouted to a shared scope demotes at write time', async () => {
    const plur = permissive()
    const e = await plur.learnRouted('benign statement', { scope: 'project:acme', attribution: { asserted_by: AWS } })
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
    expect((e as any).structured_data?._demoted?.from).toBe('project:acme')
  })

  it('learn to a shared scope demotes at write time', async () => {
    const plur = permissive()
    const e = await plur.learn('benign statement', { scope: 'project:acme', license: CONN })
    expect(e.scope).toBe('local')
  })

  describe('saveMetaEngrams', () => {
    const meta = (overrides: Record<string, unknown>) => ({
      id: 'META-2026-09-04-001', version: 2, status: 'active', consolidated: false,
      type: 'behavioral', scope: 'project:acme', visibility: 'public',
      statement: 'A meta principle', domain: 'meta', tags: ['meta-engram'],
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-09-04' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [], associations: [], derivation_count: 2,
      pack: null, abstract: null, derived_from: null, polarity: null,
      ...overrides,
    }) as unknown as Engram

    it('refuses a credential in attribution outright', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.saveMetaEngrams([meta({ attribution: { asserted_by: AWS } })]))
        .rejects.toThrow(/Secret detected in meta-engram/)
    })

    it('demotes it under allow_secrets', async () => {
      const plur = permissive()
      await plur.saveMetaEngrams([meta({ attribution: { asserted_by: AWS } })])
      const row = readRows(dir).find(r => r.id === 'META-2026-09-04-001')
      expect(row.scope).toBe('local')
      expect(row.visibility).toBe('private')
    })
  })
})

describe('the bookkeeping exemption is a list, not a prefix', () => {
  it('scans an unknown _key and skips the known ones', () => {
    const fields = engramContentFields({
      id: 'ENG-1', statement: 'x', scope: 'local',
      structured_data: { _outbox: { target_url: 'http://127.0.0.1:1' }, _demoted: { from: 'g' }, _mine: 'kept' },
    } as unknown as Engram)!
    expect(fields.structured_data).toEqual({ _mine: 'kept' })
  })
})
