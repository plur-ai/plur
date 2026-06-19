/**
 * Self-describing scope metadata (#345, Stage 2). Two surfaces:
 *
 *  1. ScopeMetadataSchema — Zod validation: required fields, defaults, and that
 *     bad input is rejected. The schema is the contract a scope declares.
 *
 *  2. The metadata-driven leak guard: when the target scope carries a
 *     `sensitivity` policy, that policy decides demotion; with no metadata the
 *     guard falls back to Stage 1 behavior EXACTLY (any sensitive hit on a
 *     shared scope demotes). Fixtures reuse the real 2026-06 leak shapes
 *     (139.59.155.82, https://t:p@hub-staging.plur.ai) so the test proves the
 *     policy gates the same content the blanket guard caught.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, ScopeMetadataSchema, SENSITIVITY_CATEGORIES, sensitivityCategory } from '../src/index.js'

describe('ScopeMetadataSchema', () => {
  it('accepts a minimal valid record and applies defaults', () => {
    const parsed = ScopeMetadataSchema.parse({
      scope: 'group:plur/engineering',
      description: 'Engineering team shared knowledge',
    })
    expect(parsed.scope).toBe('group:plur/engineering')
    expect(parsed.description).toBe('Engineering team shared knowledge')
    expect(parsed.covers).toEqual([])          // default []
    expect(parsed.sensitivity).toBeUndefined() // optional, no default
    expect(parsed.injection_policy).toBeUndefined()
    expect(parsed.owner).toBeUndefined()
  })

  // Detector hardening — Stage 1.5b (#353). 'pii' was a no-op category: no
  // detector maps to it, so `forbid: ['pii']` silently protected nothing. It
  // was removed to kill the false protection; the enum must reject it now.
  it('no longer accepts the removed "pii" category', () => {
    expect(SENSITIVITY_CATEGORIES).toEqual(['secrets', 'infra'])
    expect(SENSITIVITY_CATEGORIES as readonly string[]).not.toContain('pii')
    expect(() =>
      ScopeMetadataSchema.parse({
        scope: 'group:plur/engineering',
        description: 'has a pii forbid',
        sensitivity: { forbid: ['pii'] },
      }),
    ).toThrow()
  })

  it('applies the sensitivity defaults (forbid secrets+infra, allow none)', () => {
    const parsed = ScopeMetadataSchema.parse({
      scope: 'project:plur',
      description: 'PLUR monorepo scope',
      sensitivity: {},
    })
    expect(parsed.sensitivity?.forbid).toEqual(['secrets', 'infra'])
    expect(parsed.sensitivity?.allow).toEqual([])
  })

  it('preserves an explicit allow/forbid policy and covers', () => {
    const parsed = ScopeMetadataSchema.parse({
      scope: 'group:plur/infra',
      description: 'Infra topology lives here',
      covers: ['deployment', 'servers'],
      sensitivity: { forbid: ['secrets'], allow: ['infra'] },
      injection_policy: 'on_match',
      owner: 'gregor',
    })
    expect(parsed.covers).toEqual(['deployment', 'servers'])
    expect(parsed.sensitivity?.forbid).toEqual(['secrets'])
    expect(parsed.sensitivity?.allow).toEqual(['infra'])
    expect(parsed.injection_policy).toBe('on_match')
    expect(parsed.owner).toBe('gregor')
  })

  it('rejects missing required fields', () => {
    expect(ScopeMetadataSchema.safeParse({ description: 'no scope' }).success).toBe(false)
    expect(ScopeMetadataSchema.safeParse({ scope: 'group:x' }).success).toBe(false) // no description
  })

  it('rejects an unknown sensitivity category in forbid', () => {
    const res = ScopeMetadataSchema.safeParse({
      scope: 'group:x', description: 'd', sensitivity: { forbid: ['malware'] },
    })
    expect(res.success).toBe(false)
  })

  it('rejects an invalid injection_policy', () => {
    const res = ScopeMetadataSchema.safeParse({
      scope: 'group:x', description: 'd', injection_policy: 'sometimes',
    })
    expect(res.success).toBe(false)
  })
})

describe('sensitivityCategory — pattern → family mapping', () => {
  it('maps infra topology patterns to infra', () => {
    for (const p of ['public_ipv4', 'basic_auth_url', 'fqdn_port', 'ipv4_port'])
      expect(sensitivityCategory(p)).toBe('infra')
  })
  it('maps credential patterns to secrets', () => {
    for (const p of ['aws_access_key', 'generic_api_key', 'jwt', 'private_key', 'bearer_token'])
      expect(sensitivityCategory(p)).toBe('secrets')
  })
})

describe('metadata-driven leak guard (#345)', () => {
  const dirs: string[] = []
  /** Build a Plur whose config carries the given store entries (with metadata). */
  const plurWithStores = (stores: unknown[], extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-scope-meta-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false, ...extra }, { noRefs: true }))
    return new Plur({ path: dir })
  }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

  it('getScopeMetadata resolves metadata declared on a store entry', () => {
    const plur = plurWithStores([
      { path: '/tmp/ignored.yaml', scope: 'group:plur/infra', description: 'Infra scope', covers: ['servers'], sensitivity: { allow: ['infra'] } },
    ])
    const md = plur.getScopeMetadata('group:plur/infra')
    expect(md?.scope).toBe('group:plur/infra')
    expect(md?.description).toBe('Infra scope')
    expect(md?.covers).toEqual(['servers'])
    expect(md?.sensitivity?.allow).toEqual(['infra'])
  })

  it('returns undefined for a scope with no metadata', () => {
    const plur = plurWithStores([])
    expect(plur.getScopeMetadata('group:plur/engineering')).toBeUndefined()
  })

  // (a) scope whose sensitivity.allow contains the matched category → NOT demoted.
  it('does NOT demote when the matched category is allowed by the scope policy', () => {
    const plur = plurWithStores([
      { path: '/tmp/infra.yaml', scope: 'group:plur/infra', description: 'Infra topology home', sensitivity: { forbid: ['secrets'], allow: ['infra'] } },
    ])
    const e = plur.learn('deploy target is 139.59.155.82', { scope: 'group:plur/infra' }) as { scope: string; structured_data?: { _demoted?: unknown } }
    expect(e.scope).toBe('group:plur/infra')           // kept at the shared scope
    expect(e.structured_data?._demoted).toBeUndefined() // no demotion marker
  })

  it('still demotes a forbidden category even when another is allowed', () => {
    // allow_secrets:true bypasses the *hard* detectSecrets guard (which throws
    // outright on credential patterns, before the scope logic runs) so we can
    // exercise the *soft* per-scope policy: infra is allowed here, but secrets
    // stays forbidden, so a bearer token must still demote off the shared scope.
    const plur = plurWithStores([
      { path: '/tmp/infra.yaml', scope: 'group:plur/infra', description: 'Infra home', sensitivity: { forbid: ['secrets', 'infra'], allow: ['infra'] } },
    ], { allow_secrets: true })
    const e = plur.learn('token is Bearer abcdefghijklmnopqrstuvwxyz0123456789', { scope: 'group:plur/infra' }) as { scope: string }
    expect(e.scope).toBe('local')
  })

  // (b) scope with NO metadata + sensitive content on a shared scope → demoted (fallback unchanged).
  it('falls back to Stage 1: no metadata + sensitive content on a shared scope demotes', () => {
    const plur = plurWithStores([]) // no metadata anywhere
    const e = plur.learn('login at https://t:p@hub-staging.plur.ai', { scope: 'project:plur' }) as { scope: string; visibility: string }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
  })

  // (c) scope with the DEFAULT forbid policy + infra content → demoted.
  it('demotes under the default policy (forbid secrets+infra) with infra content', () => {
    const plur = plurWithStores([
      // declares metadata but an empty sensitivity → defaults apply (forbid secrets+infra)
      { path: '/tmp/eng.yaml', scope: 'group:plur/engineering', description: 'Engineering scope', sensitivity: {} },
    ])
    const e = plur.learn('deploy target is 139.59.155.82', { scope: 'group:plur/engineering' }) as { scope: string; visibility: string }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
  })

  it('keeps clean content at a metadata-bearing shared scope', () => {
    const plur = plurWithStores([
      { path: '/tmp/eng.yaml', scope: 'group:plur/engineering', description: 'Engineering scope', sensitivity: {} },
    ])
    const e = plur.learn('SKILL.md is the canonical pack format', { scope: 'group:plur/engineering' }) as { scope: string }
    expect(e.scope).toBe('group:plur/engineering')
  })

  it('surfaces description + covers in listStores when declared', async () => {
    const plur = plurWithStores([
      { path: '/tmp/eng.yaml', scope: 'group:plur/engineering', description: 'Eng knowledge', covers: ['ci', 'releases'] },
    ])
    const rows = await plur.listStoresAsync()
    const eng = rows.find(r => r.scope === 'group:plur/engineering')
    expect(eng?.description).toBe('Eng knowledge')
    expect(eng?.covers).toEqual(['ci', 'releases'])
  })
})
