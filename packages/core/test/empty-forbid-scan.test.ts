/**
 * #847 — an empty `forbid` array must not switch the leak guard off.
 *
 * `_offendingHitsForScope` resolved the forbidden set as
 * `new Set(policy?.forbid ?? ['secrets','infra'])`. Nullish coalescing supplies
 * the default only for null/undefined, so an explicit `[]` forbids nothing and
 * the scope's sensitive-content scan is effectively disabled.
 *
 * ## What is and is not exposed today
 *
 * Measured: `ScopeSensitivitySchema`'s `forbid` preprocess already coerces `[]`
 * to `['secrets','infra']`, so a policy that arrives through config parsing — or
 * through `RemoteStore.me()`, which uses the same schema — can never reach the
 * guard empty. Core is therefore NOT live-exposed by its own config path, and
 * these tests pin that.
 *
 * The guard itself is still wrong in isolation, which is what the issue is
 * about: it was found auditing the enterprise server, which mirrors this
 * function deliberately so a write gets the same verdict wherever it originates.
 * A mirror has no reason to also reproduce our Zod preprocess, and the issue
 * notes a downstream normaliser filling absent keys with `[]` is exactly how the
 * shape arises. So the function must be correct standalone, or the two diverge
 * and the mirror is the one that silently stops scanning.
 *
 * The last test constructs that case directly — a policy reaching the guard
 * empty, as it would from a normaliser or a mirror — and is the one that fails
 * without the fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StoreEntrySchema } from '../src/schemas/config.js'

/**
 * Trips the `infra` family (host:port topology), NOT the `secrets` family.
 *
 * Deliberate: `learn()` has a separate, EARLIER hard guard that throws outright
 * on a credential (`detectSecrets`), so a secret never reaches the scope leak
 * guard this issue is about. Infra topology is demoted rather than thrown,
 * which is the path `_offendingHitsForScope` actually governs.
 */
const INFRA = 'the staging database is reachable at db-prod.internal:5432 from the bastion'

describe('the schema already defends the config path (#847)', () => {
  it('coerces an explicit empty forbid to the full default set', () => {
    const r = StoreEntrySchema.safeParse({
      path: '/tmp/x', scope: 'group:acme/team', sensitivity: { forbid: [] },
    })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as any).sensitivity.forbid).toEqual(['secrets', 'infra'])
  })

  it('treats an empty sensitivity block the same way', () => {
    const r = StoreEntrySchema.safeParse({
      path: '/tmp/x', scope: 'group:acme/team', sensitivity: {},
    })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as any).sensitivity.forbid).toEqual(['secrets', 'infra'])
  })
})

describe('the guard is correct on its own account (#847)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-forbid-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{
        path: join(dir, 'team.yaml'), scope: 'group:acme/team', shared: true,
        description: 'a shared team scope', covers: ['software'],
        sensitivity: { forbid: ['secrets', 'infra'] },
      }],
      index: false,
    }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('demotes infra topology written to a shared scope', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn(INFRA, { scope: 'group:acme/team', type: 'behavioral' })
    expect(e.scope, 'infra topology must not land on a shared scope').not.toBe('group:acme/team')
  })

  it('still demotes when the policy reaches the guard with an EMPTY forbid', async () => {
    const plur = new Plur({ path: dir })
    // Reach past the schema deliberately. This is the shape the issue describes:
    // a layer that normalises a partial policy into a complete object by filling
    // absent keys with empty arrays — the obvious way to write such a normaliser,
    // and what a mirror of this function will produce without our preprocess.
    const entry = (plur as unknown as { config: { stores: Array<{ scope: string; sensitivity?: { forbid: string[] } }> } })
      .config.stores.find(s => s.scope === 'group:acme/team')!
    entry.sensitivity = { forbid: [] }

    const e = await plur.learn(INFRA, { scope: 'group:acme/team', type: 'behavioral' })

    // Without the fix the empty set forbids nothing, every hit is filtered out,
    // and the secret is written to the shared scope — which then looks MORE
    // governed than a scope with no policy at all, while being the only one
    // with no scan.
    expect(e.scope, 'an empty forbid disabled the scan and the topology leaked').not.toBe('group:acme/team')
  })

  it('an explicit allow still overrides the default, so this is not a blanket forbid', async () => {
    const plur = new Plur({ path: dir })
    const entry = (plur as unknown as { config: { stores: Array<{ scope: string; sensitivity?: unknown }> } })
      .config.stores.find(s => s.scope === 'group:acme/team')!
    // A scope that legitimately holds infra topology can still allow it —
    // defaulting an empty forbid must not break the allow escape hatch.
    entry.sensitivity = { forbid: [], allow: ['infra'] }

    const e = await plur.learn(INFRA, { scope: 'group:acme/team', type: 'behavioral' })
    expect(e.scope).toBe('group:acme/team')
  })
})
