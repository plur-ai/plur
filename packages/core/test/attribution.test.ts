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
