/**
 * Decision E6 (owner, 2026-09-26) and core-policy#9 (round 2, R2-CoreA).
 *
 * E6: a provenance record counts an engram as WITHHELD (not cleared to leave
 * this machine) when its visibility is `private`, OR when its scope does not
 * leave the machine (not a shared scope and not backed by a remote store) and
 * its visibility is not explicitly `public`. Public engrams stay shareable.
 *
 * core-policy#9: the readable summary must not answer "may it leave?" with yes
 * when the record does not say, and must not read a missing licence source as
 * a licence somebody chose.
 *
 * Model: spec/formal/PlurSpec/R2CoreA.lean §1. Nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { EngramSchema } from '../src/schemas/engram.js'
import { buildProvenanceRecord, summariseProvenance } from '../src/provenance.js'
import { Plur } from '../src/index.js'

const engramOf = (overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id: 'ENG-2026-08-23-001',
    statement: 'A statement',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    content_hash: 'a'.repeat(64),
    provenance: { origin: 'x', license: 'cc-by-4.0' },
    ...overrides,
  })

const subjectOf = (record: any) =>
  record['@graph'].find((n: any) => String(n['@id']).startsWith('engram:ENG'))

const withheld = (record: any): boolean => {
  const s = subjectOf(record)
  const forbidden = (s['odrl:hasPolicy']?.['odrl:prohibition'] ?? [])
    .filter((p: any) => p['engram:reason'] === 'notShared')
  // The two machine-readable answers must agree with each other.
  expect(forbidden.length > 0).toBe(s['engram:maySharePlainly'] === false)
  return s['engram:maySharePlainly'] === false
}

describe('E6 — withheld = private, or on-machine and not public', () => {
  it('withholds a global memory that is not marked public (template)', () => {
    expect(withheld(buildProvenanceRecord(engramOf({ visibility: 'template' })))).toBe(true)
  })

  it('withholds personal-family scopes (user:*, agent:*) that no remote store backs', () => {
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'user:alice', visibility: 'template' })))).toBe(true)
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'agent:bot', visibility: 'template' })))).toBe(true)
  })

  it('keeps a public global memory shareable (packs ship these)', () => {
    expect(withheld(buildProvenanceRecord(engramOf({ visibility: 'public' })))).toBe(false)
  })

  it('an explicit public clears a local memory too', () => {
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'local', visibility: 'public' })))).toBe(false)
  })

  it('private is withheld wherever it lives', () => {
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'group:acme/team', visibility: 'private' })))).toBe(true)
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'user:alice', visibility: 'private' }), [], { remoteBacked: true }))).toBe(true)
  })

  it('a shared scope, or a remote-backed personal scope, is not withheld unless private', () => {
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'group:acme/team', visibility: 'template' })))).toBe(false)
    expect(withheld(buildProvenanceRecord(engramOf({ scope: 'user:alice', visibility: 'template' }), [], { remoteBacked: true }))).toBe(false)
  })

  it('the summary follows the record, including an older record without maySharePlainly', () => {
    const rec = buildProvenanceRecord(engramOf({ visibility: 'template' })) as any
    expect(summariseProvenance(rec).fields.may_leave_this_machine).toBe(false)
    delete subjectOf(rec)['engram:maySharePlainly']
    expect(summariseProvenance(rec).fields.may_leave_this_machine).toBe(false)
    const pub = buildProvenanceRecord(engramOf({ visibility: 'public' })) as any
    delete subjectOf(pub)['engram:maySharePlainly']
    expect(summariseProvenance(pub).fields.may_leave_this_machine).toBe(true)
  })
})

describe('E6 through Plur — remote backing comes from this install\'s stores', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-prov-'))
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '',
    })) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: 'https://plur.example.com/sse', token: 'tok', scope: 'user:alice', readonly: false }],
      index: false,
    }))
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({
      engrams: [
        { ...engramOf({ id: 'ENG-2026-08-23-001', scope: 'user:alice', visibility: 'template' }) },
        { ...engramOf({ id: 'ENG-2026-08-23-002', scope: 'user:bob', visibility: 'template' }) },
      ],
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('a remote-backed personal scope may leave; an unbacked one is withheld', async () => {
    const plur = new Plur({ path: dir })
    const backed = await plur.provenanceFor('ENG-2026-08-23-001')
    const unbacked = await plur.provenanceFor('ENG-2026-08-23-002')
    expect(backed).toBeDefined()
    expect(unbacked).toBeDefined()
    expect(withheld(backed)).toBe(false)
    expect(withheld(unbacked)).toBe(true)
  })
})

describe('core-policy#9 — the summary fails closed', () => {
  it('a record with no engram node does not report may_leave_this_machine: true', () => {
    const s = summariseProvenance({ '@graph': [] } as any)
    expect(s.fields.may_leave_this_machine).toBe(false)
  })

  it('a record with no scope, no visibility and no share answer does not report it may leave', () => {
    const rec = buildProvenanceRecord(engramOf({ visibility: 'template' })) as any
    const subj = subjectOf(rec)
    delete subj['engram:maySharePlainly']
    delete subj['engram:scope']
    delete subj['engram:visibility']
    expect(summariseProvenance(rec).fields.may_leave_this_machine).toBe(false)
  })

  it('a missing licenseSource is not read as a chosen licence', () => {
    const rec = buildProvenanceRecord(engramOf({ visibility: 'public' })) as any
    delete subjectOf(rec)['engram:licenseSource']
    const s = summariseProvenance(rec)
    expect(s.fields.licence_chosen).toBe(false)
    expect(s.fields.may_redistribute).toBe(false)
    expect(s.fields.may_reuse_commercially).toBe(false)
  })

  it('good case: a chosen, recognised licence on a public memory still answers yes', () => {
    const s = summariseProvenance(buildProvenanceRecord(engramOf({ visibility: 'public' })) as any)
    expect(s.fields.may_leave_this_machine).toBe(true)
    expect(s.fields.licence_chosen).toBe(true)
    expect(s.fields.may_redistribute).toBe(true)
    expect(s.fields.may_reuse_commercially).toBe(true)
  })
})
