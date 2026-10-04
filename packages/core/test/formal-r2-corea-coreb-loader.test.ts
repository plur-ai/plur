/**
 * R2-CoreB NEEDS-FILE, applied by R2-CoreA in index.ts `_loadSecondaryAndPacks`
 * (spec/formal/findings/r2-coreb.md §1 core-policy#6, §2b core-policy#7).
 *
 * - A file-backed store row is stamped with the SAME helper as the remote recall
 *   leg (`stampStoreRow`): `_`-prefixed keys a row ships (a forged `_pack`) are
 *   dropped, and id namespacing is idempotent — the regex replace turned a row
 *   whose id already carried the store prefix into `ENG-XXX-XXX-…`.
 * - A pack row cannot ship loader markers (`_storeScope`, `_originalId`).
 *
 * No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { storePrefix, namespaceEngramId } from '../src/engrams.js'
import { tokenHealthKey } from '../src/remote-recall.js'
import { normalizeEndpointUrl } from '../src/store/remote-store.js'

/**
 * Wait until learn()'s failed first push has settled: the row records the
 * failure (`last_error`) AND its per-entry claim file is gone. Throws after
 * 10s naming the condition that never became true.
 */
async function settled(plur: Plur, id: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const row: any = await plur.getById(id)
    const failed = !!row?.structured_data?._outbox?.last_error
    const released = !existsSync(join(plur.outboxClaimsDir(), `${id.replace(/[^\w.-]/g, '_')}.json`))
    if (failed && released) return
    if (Date.now() >= deadline) {
      throw new Error(`timed out after 10s waiting for the failed first push of ${id} to settle: `
        + (!failed ? 'the row never recorded last_error' : 'its outbox claim file was never released'))
    }
    await new Promise(r => setTimeout(r, 5))
  }
}

const SCOPE = 'group:plur/eng'

describe('R2-CoreB loader fixes in _loadSecondaryAndPacks', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-loader-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function rowLike(id: string, extra: Record<string, unknown> = {}) {
    const seed = new Plur({ path: join(dir, 'seed-' + id) })
    const e = await seed.learn('Statement for ' + id, { scope: 'global' })
    return { ...(await seed.getById(e.id)), id, scope: SCOPE, ...extra }
  }

  it('file-store rows: forged _pack dropped, namespacing idempotent', async () => {
    const storePath = join(dir, 'team.yaml')
    const pre = `ENG-${storePrefix(SCOPE)}-2026-09-26-001`
    writeFileSync(storePath, yaml.dump({ engrams: [
      await rowLike('ENG-2026-09-26-002', { _pack: 'installed-pack' }),
      await rowLike(pre),
    ] }))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores: [{ path: storePath, scope: SCOPE }], index: false }))
    const plur = new Plur({ path: dir })
    const rows: any[] = await (plur as any)._loadSecondaryAndPacks()
    const forged = rows.find(r => r._originalId === 'ENG-2026-09-26-002')
    expect(forged).toBeDefined()
    expect(forged._pack).toBeUndefined()
    expect(forged._storeScope).toBe(SCOPE)
    const prefixed = rows.find(r => r._originalId === pre)
    expect(prefixed.id).toBe(namespaceEngramId(pre, SCOPE))
  })

  it('pack rows cannot ship loader markers', async () => {
    const packDir = join(dir, 'packs', 'p1')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: p1\nversion: 1.0.0\ndescription: t\nlicense: cc0-1.0\n---\n\n# p1\n')
    writeFileSync(join(packDir, 'engrams.yaml'), yaml.dump({ engrams: [
      await rowLike('ENG-2026-09-26-003', { scope: 'global', visibility: 'public', _storeScope: 'group:forged/x', _originalId: 'ENG-FORGED' }),
    ] }))
    const plur = new Plur({ path: dir })
    const rows: any[] = await (plur as any)._loadSecondaryAndPacks()
    const p = rows.find(r => r._pack === 'p1')
    expect(p).toBeDefined()
    expect(p._storeScope).toBeUndefined()
    expect(p._originalId).toBeUndefined()
  })
})

describe('R2-CoreB core-policy#3 in flushOutbox: the 429 cooldown is per credential', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-429-'))
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('a queued row is not pushed with a token that is rate-limited', async () => {
    const URL_ = 'https://plur.example.com/sse'
    const posts: string[] = []
    let fail = true
    globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push('post')
        if (fail) throw new Error('fetch failed')
        return { ok: true, status: 201, json: async () => ({ id: 'SRV-1' }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: URL_, token: 'ta', scope: 'group:acme/team', shared: true, readonly: false }], index: false,
    }))
    const plur = new Plur({ path: dir })
    const queuedRow = await plur.learn('Team fact queued while offline', { scope: 'group:acme/team' })
    // learn()'s background push holds the per-entry claim until its failure is recorded (C3).
    await settled(plur, queuedRow.id)
    fail = false
    posts.length = 0
    // Token 'ta' is in a 429 cooldown (per-credential state, CoreB format).
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache', 'remote-health.json'), JSON.stringify({
      version: 1,
      hosts: { [normalizeEndpointUrl(URL_)]: { tokens: { [tokenHealthKey('ta')]: { rate_limited_until: Date.now() + 600_000 } } } },
    }))
    const res = await plur.flushOutbox()
    expect(posts.length).toBe(0)
    expect(res.expired_warnings.join('\n')).toMatch(/rate-limited/)
  })
})
