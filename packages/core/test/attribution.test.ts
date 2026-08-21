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

  it('writes nothing when the caller supplies nothing', async () => {
    const engram = await plur.learn('No attribution supplied here', { type: 'behavioral' })
    expect(engram.attribution).toBeUndefined()
    expect(engram.claim_class).toBeUndefined()

    const reloaded = await plur.getById(engram.id)
    expect(reloaded?.attribution).toBeUndefined()
    expect(reloaded?.claim_class).toBeUndefined()
  })

  it('keeps a partial attribution partial, rather than padding it out', async () => {
    const engram = await plur.learn('Only the runtime is known here', {
      type: 'behavioral',
      attribution: { runtime: { name: 'plur-cli' } },
    })
    expect(engram.attribution).toEqual({ runtime: { name: 'plur-cli' } })
    expect(engram.attribution?.asserted_by).toBeUndefined()
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
