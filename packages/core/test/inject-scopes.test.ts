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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'

/** Install a pack whose engrams sit in `scope`. */
async function installPackInScope(plur: Plur, dir: string, name: string, scope: string, statement: string) {
  const src = join(dir, `${name}-source`)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0"\n---\n`)
  writeFileSync(join(src, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0728-${name.length}0${scope.length}
    statement: ${statement}
    type: behavioral
    scope: ${scope}
    status: active
    version: 2
    domain: ops.deploy
    tags: [deploy]
    activation:
      retrieval_strength: 0.9
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-07-28"
`)
  await plur.installPack(src)
}

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

/**
 * Mounted-scope visibility grants (#775) vs the allow-list.
 *
 * Mounting a store in `config.yaml` `stores:` grants its scope VISIBILITY
 * under a project-scope filter — that is the whole feature. What it must NOT
 * do is widen AUTHORIZATION: `options.scopes` is the fully-resolved
 * permission decision of a layer above core, and a config file must never
 * out-vote it. These are the adversarial tests for that boundary.
 */
describe('inject() — mounted-scope visibility grants (#775)', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-grants-'))
    const teamPath = join(dir, 'team.yaml')
    // The mounted team store whose scope becomes the visibility grant.
    writeFileSync(teamPath, `engrams:
  - id: ENG-2026-0730-100
    statement: the team deploys billing via the shared pipeline
    type: behavioral
    scope: group:acme/eng
    status: active
    version: 2
    domain: ops.deploy
    tags: [deploy]
    activation:
      retrieval_strength: 0.9
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-07-28"
`)
    writeFileSync(join(dir, 'config.yaml'), `stores:
  - path: ${teamPath}
    scope: group:acme/eng
`)
    plur = new Plur({ path: dir })
    await plur.ready()
    await plur.learn('alice deploys the billing service with terraform', { scope: 'user:acme:alice' })
    await plur.learn('deploys are reviewed before release', { scope: 'global' })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the mounted scope passes a project-scope VISIBILITY filter', async () => {
    // Pre-#775 this was zero: a project scope filter scored every `group:*`
    // engram 0, so team engrams from mounted stores never survived.
    const res = await plur.inject('how do we deploy billing', { scope: 'project:myapp' })
    expect(`${res.directives}\n${res.constraints}\n${res.consider}`).toContain('shared pipeline')
  })

  it('ADVERSARIAL: the grant does NOT widen the options.scopes allow-list', async () => {
    // The allow-list omits group:acme/eng. However granted for visibility,
    // the team engram must stay out — authorization always wins.
    const res = await plur.inject('how do we deploy billing', {
      scope: 'project:myapp',
      scopes: ['user:acme:alice', 'global'],
    })
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all, 'a visibility grant leaked past the authorization allow-list').not.toContain('shared pipeline')
    // …while the permitted scopes still flow: the filter narrowed, it did not break.
    expect(all).toContain('terraform')
  })

  it('ADVERSARIAL: an EMPTY allow-list still injects nothing, grants notwithstanding', async () => {
    const res = await plur.inject('how do we deploy billing', {
      scope: 'project:myapp',
      scopes: [],
    })
    expect(res.count).toBe(0)
    expect(res.injected_ids).toEqual([])
  })

  it('REGRESSION: without a mount the same group scope stays excluded', async () => {
    // The old behavior is still the right behavior for un-mounted scopes.
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-inject-nogrant-'))
    const p2 = new Plur({ path: dir2 })
    try {
      await p2.ready()
      await p2.learn('the team deploys billing via the shared pipeline', { scope: 'group:acme/eng' })
      const res = await p2.inject('how do we deploy billing', { scope: 'project:myapp' })
      expect(`${res.directives}\n${res.constraints}\n${res.consider}`).not.toContain('shared pipeline')
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})

/**
 * The same allow-list, applied to PACKS.
 *
 * A pack is installed knowledge rather than user data, which makes exempting it
 * tempting — but pack engrams carry scopes, they reach the same output, and an
 * allow-list with an exemption is not an allow-list. This half of the filter
 * shipped with no test at all, so nothing would have noticed it being dropped.
 *
 * One thing to know before adding tests here: `installPack` ALSO writes the
 * pack's engrams into the primary store (`plur.list()` returns them), so every
 * pack engram reaches `inject()` on both the engram path and the pack path.
 * Two consequences, both found by mutation testing:
 *
 *   - Exempting packs from the filter DOES leak: the pack path carries the
 *     engram past the engram path's filter. That is what these tests pin.
 *   - Dropping the pack argument entirely is NOT observable in the output,
 *     because the same statements still arrive via the engram path. So no
 *     assertion here can prove the pack path is still wired up — do not write
 *     one and believe it.
 */
describe('inject() — the allow-list applies to pack engrams', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-pack-scopes-'))
    mkdirSync(join(dir, 'packs'), { recursive: true })
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    plur = new Plur({ path: dir })
    await plur.ready()
    await installPackInScope(plur, dir, 'tenantpack', 'group:acme/eng', 'deploy billing using the tenantpack runbook')
    await installPackInScope(plur, dir, 'otherpack', 'group:other/eng', 'deploy billing using the otherpack runbook')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('excludes pack engrams whose scope is not permitted', async () => {
    const res = await plur.inject('how do we deploy billing', { scopes: ['group:acme/eng'] })
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all).toContain('tenantpack')
    expect(all, 'a pack outside the allow-list reached the context').not.toContain('otherpack')
  })

  it('an EMPTY allow-list admits no pack content either', async () => {
    const res = await plur.inject('how do we deploy billing', { scopes: [] })
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all).not.toContain('runbook')
    expect(res.count).toBe(0)
  })

  it('an ABSENT allow-list injects every pack — no blanket deny on the engram path', async () => {
    // Scope check, stated exactly: this guards the ENGRAM path only. Because
    // installPack also writes into the primary store, no assertion on inject()
    // output can see the pack path at all — verified by mutation, both
    // `packs = []` and `packs = [] when scopes is absent` leave this suite
    // fully green. Whether the pack argument is still wired up is not something
    // this file can tell you.
    const res = await plur.inject('how do we deploy billing')
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all).toContain('tenantpack')
    expect(all).toContain('otherpack')
  })

  it('a pack left with no permitted engrams is dropped, not injected empty', async () => {
    const res = await plur.inject('how do we deploy billing', { scopes: ['group:acme/eng'] })
    // `otherpack` had exactly one engram and it was filtered out, so the pack
    // itself must not survive as an empty shell in the output.
    expect(`${res.directives}\n${res.constraints}\n${res.consider}`).not.toContain('otherpack')
  })
})
