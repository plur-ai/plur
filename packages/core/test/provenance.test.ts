/**
 * Building a provenance record for an engram (#964).
 *
 * These tests protect three rules that are easy to break and expensive to break:
 *
 *   1. A record you send stands on its own, and names no other engram.
 *   2. An unknown agent is omitted, never guessed.
 *   3. An unknown licence produces no policy, never a permissive default.
 *
 * The second and third exist because a wrong record is worse than no record. It
 * looks like evidence.
 *
 * A companion check in `spec/examples/check.py` runs the output through two
 * outside implementations. These tests cover the shape; that one covers whether
 * anyone else can read it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngramSchema } from '../src/schemas/engram.js'
import type { HistoryEvent } from '../src/history.js'
import { buildProvenanceRecord, serializeProvenanceRecord } from '../src/provenance.js'
import { Plur } from '../src/index.js'

const engramOf = (overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id: 'ENG-2026-08-21-001',
    statement: 'Migrations run before deploys',
    type: 'behavioral',
    scope: 'group:swarm',
    status: 'active',
    content_hash: 'a'.repeat(64),
    ...overrides,
  })

const nodesOf = (record: any) => record['@graph'] as any[]
const nodeById = (record: any, id: string) => nodesOf(record).find(n => n['@id'] === id)
const subject = (record: any, id = 'engram:ENG-2026-08-21-001') => nodeById(record, id)

describe('buildProvenanceRecord', () => {
  it('describes the engram and says when the record was made', () => {
    const record = buildProvenanceRecord(engramOf(), [], { now: '2026-08-21T09:00:00Z' })
    expect(record['@context']).toBeDefined()

    const self = nodeById(record, 'engram:record/ENG-2026-08-21-001')
    expect(self['@type']).toContain('prov:Bundle')
    expect(self['prov:generatedAtTime']['@value']).toBe('2026-08-21T09:00:00Z')

    const thing = subject(record)
    expect(thing['@type']).toContain('prov:Entity')
    expect(thing['engram:scope']).toBe('group:swarm')
    expect(thing['engram:contentHash']).toBe(`sha256:${'a'.repeat(64)}`)
  })

  it('uses a flat graph, so an ordinary reader sees the contents', () => {
    // Putting @id/@type beside @graph makes the contents a NAMED graph, and a
    // normal parse then sees only the wrapper. That bug produced 3 statements
    // instead of 64 in the worked examples.
    const record = buildProvenanceRecord(engramOf()) as any
    expect(record['@id']).toBeUndefined()
    expect(record['@type']).toBeUndefined()
    expect(Array.isArray(record['@graph'])).toBe(true)
  })

  it('leaves the statement out unless asked', () => {
    expect(subject(buildProvenanceRecord(engramOf()))['prov:value']).toBeUndefined()
    const withText = buildProvenanceRecord(engramOf(), [], { includeStatement: true })
    expect(subject(withText)['prov:value']).toBe('Migrations run before deploys')
  })

  it('treats a web address in source as a real external source', () => {
    const withUrl = buildProvenanceRecord(engramOf({ source: 'https://example.org/a' }))
    expect(subject(withUrl)['prov:hadPrimarySource']).toEqual({ '@id': 'https://example.org/a' })

    const withNote = buildProvenanceRecord(engramOf({ source: 'a conversation on Tuesday' }))
    expect(subject(withNote)['prov:hadPrimarySource']).toBeUndefined()
    expect(subject(withNote)['engram:sourceNote']).toBe('a conversation on Tuesday')
  })
})

describe('agents — omitted, never guessed', () => {
  it('names nobody when the engram names nobody', () => {
    const record = buildProvenanceRecord(engramOf())
    expect(subject(record)['prov:wasAttributedTo']).toBeUndefined()
    expect(nodesOf(record).some(n => String(n['@id']).includes('agent'))).toBe(false)
  })

  it('records the responsibility chain when it is known', () => {
    const record = buildProvenanceRecord(engramOf({
      attribution: {
        asserted_by: 'local:maintainer',
        runtime: { name: 'plur-mcp', version: '0.18.0' },
        on_behalf_of: 'local:maintainer',
      },
    }))
    expect(subject(record)['prov:wasAttributedTo']).toEqual({ '@id': 'engram:agent/local:maintainer' })

    const software = nodeById(record, 'engram:agent/software/plur-mcp@0.18.0')
    expect(software['prov:actedOnBehalfOf']).toEqual({ '@id': 'engram:agent/local:maintainer' })
  })

  it('says plainly when nobody was identified', () => {
    const record = buildProvenanceRecord(engramOf({
      attribution: { asserted_by: 'unidentified', runtime: { name: 'plur-mcp' } },
    }))
    const agent = nodeById(record, 'engram:agent/unidentified')
    expect(agent['engram:identityKnown']).toBe(false)

    // The software is still named. An unidentified record still says what wrote it.
    expect(nodeById(record, 'engram:agent/software/plur-mcp')).toBeDefined()
  })

  it('identifies a prompt by hash and never carries its text', () => {
    const record = buildProvenanceRecord(engramOf({
      attribution: { model: { name: 'gpt-5.6-sol', prompt_sha256: 'b'.repeat(64), prompt_version: '3' } },
    }))
    const model = nodeById(record, 'engram:model/gpt-5.6-sol')
    expect(model['engram:promptHash']).toBe(`sha256:${'b'.repeat(64)}`)
    expect(JSON.stringify(record)).not.toContain('prompt_text')
  })
})

describe('licences — a summary, never a guess', () => {
  it('expresses the default licence with its duties', () => {
    const policy = subject(buildProvenanceRecord(engramOf()))['odrl:hasPolicy']
    expect(policy['odrl:uid']).toBe('https://creativecommons.org/licenses/by-sa/4.0/')
    const duties = policy['odrl:permission'][0]['odrl:duty'].map((d: any) => d['odrl:action'])
    expect(duties).toEqual(['odrl:attribute', 'odrl:shareAlike'])
  })

  it('expresses a prohibition when the licence has one', () => {
    const record = buildProvenanceRecord(engramOf({ provenance: { origin: 'x', license: 'cc-by-nc-4.0' } }))
    const policy = subject(record)['odrl:hasPolicy']
    expect(policy['odrl:prohibition']).toEqual([{ 'odrl:action': 'odrl:commercialize' }])
  })

  it('emits no policy for a licence it does not recognise', () => {
    // Not a permissive default, not a guess. The reader is told the name and
    // left to go and look.
    const record = buildProvenanceRecord(engramOf({
      provenance: { origin: 'x', license: 'some-bespoke-licence-2.1' },
    }))
    expect(subject(record)['odrl:hasPolicy']).toBeUndefined()
    expect(subject(record)['engram:license']).toBe('some-bespoke-licence-2.1')
  })
})

describe('activities from the history log', () => {
  const event = (e: string, data: Record<string, unknown> = {}, extra: Partial<HistoryEvent> = {}): HistoryEvent => ({
    event: e as HistoryEvent['event'],
    engram_id: 'ENG-2026-08-21-001',
    timestamp: '2026-08-21T10:00:00Z',
    data,
    ...extra,
  })

  it('turns a creation into a learning step that generated the engram', () => {
    const record = buildProvenanceRecord(engramOf(), [event('engram_created')])
    const act = nodeById(record, 'engram:act/ENG-2026-08-21-001-engram_created')
    expect(act['@type']).toContain('engram:Learn')
    expect(act['prov:generated']).toEqual({ '@id': 'engram:ENG-2026-08-21-001' })
  })

  it('turns a retirement into an invalidation', () => {
    // Without this, a memory nobody believes looks the same as one that never existed.
    const record = buildProvenanceRecord(engramOf(), [event('engram_retired', { reason: 'superseded' })])
    expect(subject(record)['prov:wasInvalidatedBy']).toBeDefined()
    expect(subject(record)['prov:invalidatedAtTime']['@value']).toBe('2026-08-21T10:00:00Z')
  })

  it('carries a reason when one was recorded', () => {
    const record = buildProvenanceRecord(engramOf(), [event('engram_retired', { reason: 'superseded' })])
    const act = nodeById(record, 'engram:act/ENG-2026-08-21-001-engram_retired')
    expect(act['engram:reason']).toBe('superseded')
  })

  it('ignores event types that are declared but never written', () => {
    const record = buildProvenanceRecord(engramOf(), [event('weekly_review'), event('buffer_pruned')])
    expect(nodesOf(record).filter(n => String(n['@type']).includes('Activity'))).toHaveLength(0)
  })
})

describe('a record you send names no other engram', () => {
  const injection = (): HistoryEvent => ({
    event: 'co_injection',
    engram_id: 'INJ-123',
    timestamp: '2026-08-21T11:00:00Z',
    data: {
      ids: ['ENG-2026-08-21-001', 'ENG-other-1', 'ENG-other-2'],
      query_hash: 'abcdef0123456789',
      session_id: 'sess-private',
    },
  })

  it('names only its own subject, and counts the rest', () => {
    // The log lists every engram injected together. Copying that list would tell
    // the recipient the identifiers of other memories the sender holds.
    const record = buildProvenanceRecord(engramOf(), [injection()], { mode: 'portable' })
    const act = nodeById(record, 'engram:act/INJ-123')
    expect(act['prov:used']).toEqual({ '@id': 'engram:ENG-2026-08-21-001' })
    expect(act['engram:usedAlongsideCount']).toBe(2)

    const text = serializeProvenanceRecord(record)
    expect(text).not.toContain('ENG-other-1')
    expect(text).not.toContain('ENG-other-2')
  })

  it('carries no session identifier, which means nothing to a recipient', () => {
    const record = buildProvenanceRecord(engramOf(), [injection()], { mode: 'portable' })
    expect(serializeProvenanceRecord(record)).not.toContain('sess-private')
  })

  it('may name the others in a local record, where the reader has our files', () => {
    const record = buildProvenanceRecord(engramOf(), [injection()], { mode: 'local' })
    const act = nodeById(record, 'engram:act/INJ-123')
    expect(act['prov:used']).toHaveLength(3)
    expect(serializeProvenanceRecord(record)).toContain('sess-private')
  })

  it('defaults to portable, because that is where a mistake does harm', () => {
    const record = buildProvenanceRecord(engramOf(), [injection()])
    expect(serializeProvenanceRecord(record)).not.toContain('ENG-other-1')
  })

  it('leaves no reference a recipient cannot resolve', () => {
    const record = buildProvenanceRecord(engramOf({
      attribution: { asserted_by: 'local:maintainer', runtime: { name: 'plur-mcp' } },
    }), [injection()], { mode: 'portable' })

    const described = new Set(nodesOf(record).map(n => n['@id']))
    const dangling: string[] = []
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (v && typeof v === 'object') {
        const id = (v as any)['@id']
        if (typeof id === 'string' && id.startsWith('engram:') && !described.has(id)) dangling.push(id)
        Object.values(v as object).forEach(walk)
      }
    }
    nodesOf(record).forEach(walk)
    expect(dangling).toEqual([])
  })
})

describe('through a real store', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-provenance-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds a record for an engram that was really written', async () => {
    const engram = await plur.learn('A real engram written to a real store', {
      type: 'behavioral',
      attribution: { asserted_by: 'unidentified', runtime: { name: 'plur-core' } },
      claim_class: 'asserted',
    })
    const record = buildProvenanceRecord(engram as any, plur.getEngramHistory(engram.id))
    const thing = subject(record, `engram:${engram.id}`)

    expect(thing['engram:claimClass']).toBe('asserted')
    expect(thing['prov:generatedAtTime']).toBeDefined()
    expect(thing['odrl:hasPolicy']).toBeDefined()

    // The five questions a recipient must be able to answer.
    expect(thing['prov:wasAttributedTo']).toBeDefined()   // who
    expect(thing['engram:claimClass']).toBeDefined()      // how
    expect(thing['prov:generatedAtTime']).toBeDefined()   // when
    expect(thing['engram:license']).toBeDefined()         // may I use it
  })

  it('falls back to the first write time when learned_at is absent', async () => {
    // temporal.learned_at is missing on ordinary engrams — the code that builds
    // it returns nothing unless an expiry was supplied.
    const engram = await plur.learn('No expiry, so no learned_at', { type: 'behavioral' })
    const record = buildProvenanceRecord(engram as any)
    expect(subject(record, `engram:${engram.id}`)['prov:generatedAtTime']).toBeDefined()
  })
})

/**
 * Findings from two testers who used this cold (#970).
 *
 * Each of these is a defect they hit, kept as a test so it cannot come back.
 */
describe('what the testers found', () => {
  const engramOf2 = (overrides: Record<string, unknown> = {}) =>
    EngramSchema.parse({
      id: 'ENG-2026-08-23-001',
      statement: 'The API key lives in the vault',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
      content_hash: 'f'.repeat(64),
      ...overrides,
    })

  it('does not let the licence read as permission to share a private memory', async () => {
    // A tester asked "may I share this private local secret" and was told
    // "reuse allowed, credit required, distribute". The licence governs the
    // content; it is not permission to share the memory. The caveat sits on
    // the licence line, because that is the line that misleads.
    const { summariseProvenance } = await import('../src/provenance.js')
    const record = buildProvenanceRecord(engramOf2({ scope: 'local', visibility: 'private' }))
    const summary = summariseProvenance(record as any)

    expect(summary.private).toBe(true)
    expect(summary.fields.shareable).toBe(false)
    expect(summary.lines.join('\n')).toContain('Not permission to share')
  })

  it('does not shout on every engram, because private is the default', async () => {
    // Every engram is private unless someone says otherwise. A warning that
    // fires on all of them is noise, and noise is how real warnings get
    // ignored — so the caveat is one line attached to the licence, not a banner.
    const { summariseProvenance } = await import('../src/provenance.js')
    const summary = summariseProvenance(buildProvenanceRecord(engramOf2()) as any)
    const shouty = summary.lines.filter(l => l.includes('Not permission to share'))
    expect(shouty.length).toBeLessThanOrEqual(1)
  })

  it('still says what the licence means when nobody chose it', async () => {
    // Marking it unchosen is the fix; hiding what it means is a different bug.
    // The default genuinely applies, so a reader needs to know what it says.
    const { summariseProvenance } = await import('../src/provenance.js')
    const summary = summariseProvenance(buildProvenanceRecord(engramOf2()) as any)
    expect(summary.lines.join('\n')).toContain('credit required')
    expect(summary.fields.licence?.chosen).toBe(false)
  })

  it('does not present an unchosen licence as a recorded fact', async () => {
    // The licence is a schema default. Printing it beside recorded facts, under
    // a footer saying nothing is guessed, made the one legally-consequential
    // field the one invented field.
    const { summariseProvenance } = await import('../src/provenance.js')
    const summary = summariseProvenance(buildProvenanceRecord(engramOf2()) as any)

    expect(summary.fields.licence?.chosen).toBe(false)
    expect(summary.lines.join('\n')).toContain('Nobody chose this licence')
    expect(summary.missing.join(' ')).toContain('licence was never chosen')
  })

  it('marks a licence somebody actually chose as chosen', async () => {
    const { summariseProvenance } = await import('../src/provenance.js')
    const record = buildProvenanceRecord(engramOf2({
      provenance: { origin: 'x', license: 'cc-by-nc-4.0' },
    }))
    const summary = summariseProvenance(record as any)
    expect(summary.fields.licence?.chosen).toBe(true)
    expect(summary.lines.join('\n')).not.toContain('Nobody chose this licence')
  })

  it('returns values as data, not as padded display strings', async () => {
    // A consumer must never split "Licence       cc-by-sa-4.0 — reuse allowed"
    // on whitespace to recover a licence name.
    const { summariseProvenance } = await import('../src/provenance.js')
    const summary = summariseProvenance(buildProvenanceRecord(engramOf2()) as any)
    expect(summary.fields.licence?.name).toBe('cc-by-sa-4.0')
    expect(summary.fields.scope).toBe('global')
    expect(typeof summary.fields.shareable).toBe('boolean')
  })

  it('names the recorded steps rather than counting them', async () => {
    // "History 1 recorded step(s)" told a tester nothing at all.
    const { summariseProvenance } = await import('../src/provenance.js')
    const record = buildProvenanceRecord(engramOf2(), [
      { event: 'engram_created', engram_id: 'ENG-2026-08-23-001', timestamp: '2026-08-23T00:00:00Z', data: {} },
    ] as any)
    const summary = summariseProvenance(record as any)
    expect(summary.lines.join('\n')).toMatch(/History\s+learn/)
  })

  it('shows what the memory says when the statement travels', async () => {
    // Searching fuzzily returned an id and metadata with no statement, so a
    // reader could not tell whether the right memory had been found — while
    // the REJECTED candidates did show theirs.
    const { summariseProvenance } = await import('../src/provenance.js')
    const record = buildProvenanceRecord(engramOf2(), [], { includeStatement: true })
    const summary = summariseProvenance(record as any)
    expect(summary.fields.says).toContain('API key lives in the vault')
    expect(summary.lines.join('\n')).toContain('Says')
  })

  it('does not claim a person stated something when a model may have', async () => {
    // "stated outright by a person or agent" refused to answer the very
    // question being asked.
    const { summariseProvenance } = await import('../src/provenance.js')
    const record = buildProvenanceRecord(engramOf2({ claim_class: 'asserted' }))
    const summary = summariseProvenance(record as any)
    expect(summary.fields.claim_meaning).not.toContain('or agent')
    expect(summary.fields.claim_meaning).toContain('rather than a model')
  })
})
