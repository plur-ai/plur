/**
 * Formal-verification apply phase, decision E3 ("opencode rule everywhere"),
 * 2026-09-26.
 *
 * A `.plur.yaml` `scope`/`domain` from a directory the user has not trusted
 * (`plur trust <dir>`) is ignored by every CLI hook adapter, with a notice that
 * names the file and the trust command — the rule @plur-ai/opencode already
 * followed (`resolveTrustedScope`). Before, the hooks adopted a cloned repo's
 * scope as "a local filter that needs no gate" and told the model to learn
 * under it. Trusted directories behave as before.
 * spec/formal/findings/adapters.md §9, PlurSpec/Adapters.lean §9.
 */
import { describe, it, expect } from 'vitest'

// Imported lazily so a plur.ts that does not export the helper yet fails on
// the assertions, not at import.
const helper = async () => (await import('../src/plur.js') as any).trustedProjectScope as
  (t: { isDirectoryTrusted(d: string): boolean }, c: { scope?: string; domain?: string }, dir: string | null) =>
    { scope?: string; domain?: string; notice?: string }

describe('trustedProjectScope (E3)', () => {
  const cfg = { scope: 'group:acme/eng', domain: 'acme.eng' }
  it('ignores scope/domain from an untrusted directory and names the file', async () => {
    const r = (await helper())({ isDirectoryTrusted: () => false }, cfg, '/repo')
    expect(r.scope).toBeUndefined()
    expect(r.domain).toBeUndefined()
    expect(r.notice).toContain('/repo/.plur.yaml')
    expect(r.notice).toContain('plur trust /repo')
  })
  it('adopts them from a trusted directory (good case)', async () => {
    const r = (await helper())({ isDirectoryTrusted: () => true }, cfg, '/repo')
    expect(r).toMatchObject({ scope: 'group:acme/eng', domain: 'acme.eng' })
    expect(r.notice).toBeUndefined()
  })
  it('fails closed when the trust check throws', async () => {
    const r = (await helper())({ isDirectoryTrusted: () => { throw new Error('x') } }, cfg, '/repo')
    expect(r.scope).toBeUndefined()
  })
})
