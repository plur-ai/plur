/**
 * Attribution and claim class (#961, #963).
 *
 * Two facts about an engram that cannot be recovered after the write: who
 * asserted it, and what kind of claim it is. A statement a person typed, a line
 * a pattern scraped and a conclusion a model inferred are stored identically
 * today, so a reader cannot tell them apart.
 *
 * The rule these tests exist to protect: **omit rather than guess**. A record
 * with no agent is valid and honest. A record with an invented agent is worse
 * than one with none, because it looks like evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EngramSchema,
  AttributionSchema,
  ClaimClassSchema,
  ATTRIBUTION_UNIDENTIFIED,
} from '../src/schemas/engram.js'
import { Plur } from '../src/index.js'

const base = {
  id: 'ENG-2026-08-21-001',
  statement: 'Deploys run after migrations, never before',
  type: 'behavioral' as const,
  scope: 'global',
  status: 'active' as const,
}

describe('AttributionSchema', () => {
  it('accepts a full attribution', () => {
    const result = AttributionSchema.safeParse({
      asserted_by: 'did:key:z6Mkfoo',
      runtime: { name: 'plur-mcp', version: '0.18.0' },
      model: {
        name: 'gpt-5.6-sol',
        prompt_id: 'dedup',
        prompt_version: '3',
        prompt_sha256: 'a'.repeat(64),
      },
      tool: { name: 'plur-encode', version: '0.2.0' },
      on_behalf_of: 'local:maintainer',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a partial attribution — every sub-field is optional', () => {
    expect(AttributionSchema.safeParse({ asserted_by: 'local:maintainer' }).success).toBe(true)
    expect(AttributionSchema.safeParse({ runtime: { name: 'plur-cli' } }).success).toBe(true)
    expect(AttributionSchema.safeParse({}).success).toBe(true)
  })

  it('exposes a well-known value for "nobody was identified"', () => {
    // Absence cannot be told apart from a record written before we captured
    // identity at all. The marker distinguishes the two.
    expect(ATTRIBUTION_UNIDENTIFIED).toBe('unidentified')
    const result = AttributionSchema.safeParse({ asserted_by: ATTRIBUTION_UNIDENTIFIED })
    expect(result.success).toBe(true)
  })

  it('requires a name when a runtime, model or tool is given', () => {
    expect(AttributionSchema.safeParse({ runtime: { version: '1.0' } }).success).toBe(false)
    expect(AttributionSchema.safeParse({ model: { prompt_id: 'x' } }).success).toBe(false)
    expect(AttributionSchema.safeParse({ tool: { version: '1.0' } }).success).toBe(false)
  })
})

describe('ClaimClassSchema', () => {
  it('accepts the six kinds of claim', () => {
    for (const kind of ['observed', 'documented', 'structural', 'asserted', 'inferred', 'revised']) {
      expect(ClaimClassSchema.safeParse(kind).success).toBe(true)
    }
  })

  it('rejects anything else, so a typo cannot become a silent third category', () => {
    expect(ClaimClassSchema.safeParse('guessed').success).toBe(false)
    expect(ClaimClassSchema.safeParse('').success).toBe(false)
  })
})

describe('EngramSchema with attribution and claim_class', () => {
  it('parses an engram carrying both', () => {
    const engram = EngramSchema.parse({
      ...base,
      attribution: { asserted_by: 'local:maintainer', runtime: { name: 'plur-mcp', version: '0.18.0' } },
      claim_class: 'asserted',
    })
    expect(engram.attribution?.asserted_by).toBe('local:maintainer')
    expect(engram.attribution?.runtime?.name).toBe('plur-mcp')
    expect(engram.claim_class).toBe('asserted')
  })

  it('parses an engram without them — the fields are absent, not null', () => {
    const engram = EngramSchema.parse(base)
    expect(engram.attribution).toBeUndefined()
    expect(engram.claim_class).toBeUndefined()
  })

  it('does not invent a default claim class', () => {
    // An unset claim class means "we could not tell". Defaulting it to anything
    // would assert something nobody checked.
    const engram = EngramSchema.parse(base)
    expect(engram.claim_class).toBeUndefined()
  })
})

describe('attribution through a real store (#961, #963)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-attribution-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('survives a write, a reload and a recall', async () => {
    const attribution = {
      asserted_by: 'local:maintainer',
      runtime: { name: 'plur-mcp', version: '0.18.0' },
      on_behalf_of: 'local:maintainer',
    }
    const engram = await plur.learn('Migrations run before deploys', {
      type: 'behavioral',
      attribution,
      claim_class: 'asserted',
    })
    expect(engram.attribution).toEqual(attribution)
    expect(engram.claim_class).toBe('asserted')

    const reloaded = await plur.getById(engram.id)
    expect(reloaded?.attribution).toEqual(attribution)
    expect(reloaded?.claim_class).toBe('asserted')

    const results = await plur.recall('migrations deploys')
    const found = results.find(r => r.id === engram.id)
    expect(found).toBeDefined()
    expect((found as any).attribution).toEqual(attribution)
  })

  it('records the two things it knows, and invents nothing else', async () => {
    // This used to assert that an unsupplied attribution stayed absent
    // entirely. That was the bug, not the contract: the profile says the
    // software is ALWAYS knowable and an unidentified writer should be marked
    // as such, because an absent field cannot be told apart from a record
    // written before identity was captured at all.
    //
    // What must still never appear is a GUESS. No model, no tool, no delegation
    // and no claim class — those are unknown, and unknown stays unknown.
    const engram = await plur.learn('No attribution supplied here', { type: 'behavioral' })
    expect(engram.attribution).toEqual({
      asserted_by: 'unidentified',
      runtime: { name: 'plur-core' },
    })
    expect(engram.attribution?.model).toBeUndefined()
    expect(engram.attribution?.tool).toBeUndefined()
    expect(engram.attribution?.on_behalf_of).toBeUndefined()
    expect(engram.claim_class).toBeUndefined()

    const reloaded = await plur.getById(engram.id)
    expect(reloaded?.attribution?.asserted_by).toBe('unidentified')
    expect(reloaded?.claim_class).toBeUndefined()
  })

  it('keeps a partial attribution partial, rather than padding it out', async () => {
    // A caller-supplied runtime is kept exactly as given, and the unknown
    // author becomes the marker rather than a guess. Nothing else is added.
    const engram = await plur.learn('Only the runtime is known here', {
      type: 'behavioral',
      attribution: { runtime: { name: 'plur-cli' } },
    })
    expect(engram.attribution).toEqual({
      asserted_by: 'unidentified',
      runtime: { name: 'plur-cli' },
    })
  })

  it('records that nobody was identified, when that is the truth', async () => {
    const engram = await plur.learn('Written with no identity configured', {
      type: 'behavioral',
      attribution: { asserted_by: ATTRIBUTION_UNIDENTIFIED, runtime: { name: 'plur-mcp' } },
      claim_class: 'inferred',
    })
    expect(engram.attribution?.asserted_by).toBe(ATTRIBUTION_UNIDENTIFIED)

    // The software is still named. An unidentified record still says what wrote it.
    expect(engram.attribution?.runtime?.name).toBe('plur-mcp')
  })

  it('still loads an engram written before these fields existed', async () => {
    const engram = await plur.learn('Written the old way', { type: 'behavioral' })
    const reloaded = await plur.getById(engram.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.statement).toBe('Written the old way')
  })
})

describe('an identity comes from config, never from the machine (#961)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-identity-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const firstEngram = async (plur: Plur) => (await plur.list())[0] as any

  it('records the unidentified marker when nobody is configured', async () => {
    // Writing the marker rather than omitting the field is the point: an absent
    // field cannot be told apart from a record written before identity existed.
    const plur = new Plur({ path: dir })
    await plur.learn('Pools cap at 100', { type: 'architectural' })
    expect((await firstEngram(plur)).attribution.asserted_by).toBe('unidentified')
  })

  it('never takes the identity from the operating system account', async () => {
    // The obvious value, and the wrong one. It would put a real name into
    // shared records because somebody installed software.
    const plur = new Plur({ path: dir })
    await plur.learn('Pools cap at 100', { type: 'architectural' })
    const who = (await firstEngram(plur)).attribution.asserted_by
    for (const leak of [process.env.USER, process.env.USERNAME, process.env.LOGNAME]) {
      if (leak) expect(who).not.toBe(leak)
    }
  })

  it('uses the configured identity once one is set', async () => {
    const plur = new Plur({ path: dir })
    plur.setIdentity('local:maintainer')
    await plur.learn('Pools cap at 100', { type: 'architectural' })
    expect((await firstEngram(plur)).attribution.asserted_by).toBe('local:maintainer')
  })

  it('accepts a Decentralized Identifier, because the form is not fixed', async () => {
    const plur = new Plur({ path: dir })
    plur.setIdentity('did:web:example.org:alex')
    await plur.learn('Pools cap at 100', { type: 'architectural' })
    expect((await firstEngram(plur)).attribution.asserted_by).toBe('did:web:example.org:alex')
  })

  it('lets a single write override the configured identity', async () => {
    // The use case is real: recording something on somebody else's behalf.
    const plur = new Plur({ path: dir })
    plur.setIdentity('local:maintainer')
    await plur.learn('Pools cap at 100', {
      type: 'architectural', attribution: { asserted_by: 'local:priya' },
    })
    expect((await firstEngram(plur)).attribution.asserted_by).toBe('local:priya')
  })

  it('does not rewrite memories already written when the identity changes', async () => {
    // Changing them to match a later decision would be editing history, and
    // recording who said what is the entire point.
    const plur = new Plur({ path: dir })
    plur.setIdentity('local:first')
    await plur.learn('Pools cap at 100', { type: 'architectural' })
    plur.setIdentity('local:second')
    await plur.learn('Deploys wait for migrations', { type: 'behavioral' })

    const all = await plur.list()
    const byStatement = Object.fromEntries(
      all.map((e: any) => [e.statement.slice(0, 5), e.attribution.asserted_by]))
    expect(byStatement['Pools']).toBe('local:first')
    expect(byStatement['Deplo']).toBe('local:second')
  })

  it('clearing the identity returns to the marker, and says so', async () => {
    const plur = new Plur({ path: dir })
    plur.setIdentity('local:maintainer')
    expect(plur.identity()).toEqual({ identity: 'local:maintainer', stated: true })
    expect(plur.setIdentity(null)).toEqual({ identity: 'unidentified', stated: false })
  })

  it('always records what software wrote the memory', async () => {
    // The one fact we always have. A caller that knows its own version wins;
    // core is the honest floor beneath it.
    const plur = new Plur({ path: dir })
    await plur.learn('Pools cap at 100', { type: 'architectural' })
    expect((await firstEngram(plur)).attribution.runtime.name).toBe('plur-core')

    await plur.learn('Deploys wait for migrations', {
      type: 'behavioral', attribution: { runtime: { name: 'plur-mcp', version: '0.18.0' } },
    })
    const mcp = (await plur.list()).find((e: any) => e.statement.startsWith('Deploys')) as any
    expect(mcp.attribution.runtime).toEqual({ name: 'plur-mcp', version: '0.18.0' })
  })
})

describe('who caused an event, as distinct from who asserted the engram (#959)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-event-actor-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const activities = (record: any) =>
    (record['@graph'] as any[]).filter(n =>
      Array.isArray(n['@type']) && n['@type'].includes('prov:Activity'))
  const actorOf = (record: any, kind: string) =>
    activities(record).find(a => (a['@type'] as string[]).includes(kind))?.['engram:causedBy']?.['@id']

  it('does not attribute a correction to the person it corrected', () => {
    // The collapse an outside reviewer warned about on the epic: a correction
    // needs both what it replaces and who made it, and merging the two loses
    // the ability to answer either. Every activity used to take the ENGRAM's
    // attribution, so a memory Alice asserted and Bob retired showed the
    // retirement associated with Alice.
    const plur = new Plur({ path: dir })
    plur.setIdentity('local:alice')
    return (async () => {
      const engram = await plur.learn('Pools cap at 100', { type: 'architectural' })
      plur.setIdentity('local:bob')
      await plur.forget(engram.id, 'superseded by measurement')

      const record = await plur.provenanceFor(engram.id, { mode: 'local' }) as any
      const subject = (record['@graph'] as any[]).find(n =>
        Array.isArray(n['@type']) && n['@type'].includes('engram:Engram'))

      expect(subject['prov:wasAttributedTo']['@id']).toContain('alice')
      expect(actorOf(record, 'engram:Learn')).toContain('alice')
      expect(actorOf(record, 'engram:Retire')).toContain('bob')
    })()
  })

  it('records why, alongside who', async () => {
    const plur = new Plur({ path: dir })
    const engram = await plur.learn('Pools cap at 100', { type: 'architectural' })
    await plur.forget(engram.id, 'superseded by measurement')
    const record = await plur.provenanceFor(engram.id, { mode: 'local' }) as any
    const retire = activities(record).find(a => (a['@type'] as string[]).includes('engram:Retire'))
    expect(retire['engram:reason']).toBe('superseded by measurement')
  })

  it('stamps an actor on events written through any path', async () => {
    // 28 call sites append history. Stamping centrally is what makes this true
    // of all of them, including ones added later.
    const plur = new Plur({ path: dir })
    plur.setIdentity('local:alex')
    const engram = await plur.learn('Pools cap at 100', { type: 'architectural' })
    const { readHistoryForEngram } = await import('../src/history.js')
    const events = readHistoryForEngram(plur.paths.root, engram.id)
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(e.actor?.asserted_by, `${e.event} has no actor`).toBe('local:alex')
      expect(e.actor?.runtime?.name, `${e.event} has no runtime`).toBe('plur-core')
    }
  })
})

describe('the derivation chain, the last of the four dormant fields', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-chain-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records ancestors nearest first, transitively', async () => {
    const plur = new Plur({ path: dir })
    const a = await plur.learn('Pools cap at 100', { type: 'architectural' })
    const b = await plur.learn('Pools cap at 150', { type: 'architectural', supersedes: [a.id] })
    const c = await plur.learn('Pools cap at 200', { type: 'architectural', supersedes: [b.id] })

    const fresh = await plur.getById(c.id) as any
    expect(fresh.provenance.chain).toEqual([b.id, a.id])
  })

  it('leaves the block off entirely when there is nothing to put in it', async () => {
    // An origin of "direct" and an empty chain say nothing, and a block
    // containing only those is noise on every engram in the store.
    const plur = new Plur({ path: dir })
    const engram = await plur.learn('Pools cap at 100', { type: 'architectural' })
    expect((await plur.getById(engram.id) as any).provenance).toBeUndefined()
  })

  it('does not hang on a chain that loops back on itself', async () => {
    // Supersession is acyclic by construction, so this cycle is forged by
    // editing the store file — which is exactly the scenario worth guarding.
    // The file is plain YAML precisely so a person can edit it, and a chain
    // assembled from hand-edited data has no business hanging on a loop
    // somebody typed.
    let plur = new Plur({ path: dir })
    const a = await plur.learn('First', { type: 'architectural' })
    const b = await plur.learn('Second', { type: 'architectural', supersedes: [a.id] })

    const yaml = await import('js-yaml')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const doc = yaml.load(readFileSync(plur.paths.engrams, 'utf8')) as any
    const first = doc.engrams.find((e: any) => e.id === a.id)
    first.provenance = { origin: 'direct', chain: [b.id], signature: null }
    writeFileSync(plur.paths.engrams, yaml.dump(doc))

    plur = new Plur({ path: dir })
    const c = await plur.learn('Third', { type: 'architectural', supersedes: [b.id] })
    const chain = (await plur.getById(c.id) as any).provenance.chain
    // Terminates, visits nothing twice, and stays inside the depth bound.
    expect(new Set(chain).size).toBe(chain.length)
    expect(chain.length).toBeLessThanOrEqual(32)
    expect(chain).toContain(b.id)
  })

  it('does not list a shared ancestor twice', async () => {
    const plur = new Plur({ path: dir })
    const root = await plur.learn('Root fact', { type: 'architectural' })
    const left = await plur.learn('Left branch', { type: 'architectural', supersedes: [root.id] })
    const merged = await plur.learn('Merged view', {
      type: 'architectural', supersedes: [left.id, root.id],
    })
    const chain = (await plur.getById(merged.id) as any).provenance.chain
    expect(new Set(chain).size).toBe(chain.length)
    expect(chain).toEqual([left.id, root.id])
  })
})
