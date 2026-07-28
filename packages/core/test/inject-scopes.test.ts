/**
 * `inject()` under a permitted-scope allow-list.
 *
 * `RecallOptions` gained `scopes` in Phase 3; `InjectOptions` did not. That left
 * the widest surface in the API — the one a session calls on every prompt —
 * with no authorization filter at all.
 *
 * Its only scope input was `options.scope`, which is a VISIBILITY filter and
 * deliberately passes the entire personal family through (`local`, `global`,
 * `user:*`, `agent:*`). That is correct for a single user and wrong for a
 * multi-tenant caller: without an allow-list above it, every principal's
 * personal engrams reach every other principal's context. The visibility filter
 * was doing exactly what it is designed to do; there was simply nothing above
 * it.
 *
 * So the first test here is the leak, expressed as the thing that must NOT
 * happen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'

describe('inject() — permitted-scope allow-list', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-scopes-'))
    plur = new Plur({ path: dir })
    await plur.ready()

    // Two tenants' personal engrams plus one shared and one global.
    await plur.learn('alice deploys the billing service with terraform', { scope: 'user:acme:alice' })
    await plur.learn('bob deploys the billing service with pulumi', { scope: 'user:acme:bob' })
    await plur.learn('the team deploys billing via the shared pipeline', { scope: 'group:acme/eng' })
    await plur.learn('deploys are reviewed before release', { scope: 'global' })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not put one principal's personal engrams in another's context", async () => {
    // The leak. `user:acme:bob` is personal-family, so the VISIBILITY filter
    // passes it through unconditionally — an allow-list is the only thing that
    // can exclude it.
    const res = await plur.inject('how do we deploy billing', {
      scopes: ['user:acme:alice', 'global'],
    })
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all).not.toContain('pulumi')
    expect(all).not.toContain('shared pipeline')
  })

  it('admits exactly the listed scopes', async () => {
    const res = await plur.inject('how do we deploy billing', { scopes: ['user:acme:bob'] })
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all).toContain('pulumi')
    expect(all).not.toContain('terraform')
  })

  it('an EMPTY allow-list injects nothing, never everything', async () => {
    // The privilege-escalation case: a principal with zero permitted scopes
    // must see zero engrams. A truthiness guard would widen `[]` to "no filter".
    const res = await plur.inject('how do we deploy billing', { scopes: [] })
    expect(res.count).toBe(0)
    expect(res.injected_ids).toEqual([])
  })

  it('an ABSENT allow-list is unrestricted — existing behaviour unchanged', async () => {
    const scoped = await plur.inject('how do we deploy billing', { scopes: undefined })
    const bare = await plur.inject('how do we deploy billing')
    expect(scoped.injected_ids).toEqual(bare.injected_ids)
    expect(bare.count).toBeGreaterThan(0)
  })

  it('does no hierarchy expansion — the list is the complete answer', async () => {
    // `group:acme/eng` must NOT be admitted by listing its parent. Unlike the
    // visibility filter, an authorization list expands nothing.
    const res = await plur.inject('how do we deploy billing', { scopes: ['group:acme'] })
    expect(`${res.directives}\n${res.constraints}\n${res.consider}`).not.toContain('shared pipeline')
  })

  it('injectHybrid honours the allow-list too', async () => {
    // Both surfaces route through the same formatter; this pins that they stay
    // that way, since injectHybrid is the one a session actually calls.
    const res = await plur.injectHybrid('how do we deploy billing', { scopes: [] })
    expect(res.count).toBe(0)
  })
})
