/**
 * #863 — a `supersedes` edge must survive the flush, or the flush must refuse.
 *
 * The server assigns its own id on flush, so a `supersedes` pointing at a LOCAL
 * id means nothing there and was silently dropped. A correction and the thing it
 * corrected both landed as independent, equally-authoritative records:
 *
 *   ENG-2026-08-10-071  "...the replacement trigger is enabling the nightly timer..."
 *   ENG-2026-08-10-073  supersedes [071]  "...there is NO trigger tied to the timer..."
 *
 * became two unrelated `ENG-GDA-*` rows, both ending "Do NOT re-raise this as a
 * new concern; it is a recorded decision, not an oversight."
 *
 * Worse than a broken link. Per the tool contract, supersedes-linked pairs are
 * SKIPPED by tension scans — so dropping the edge keeps the stale statement live
 * at equal weight AND makes the pair look like a genuine contradiction to the
 * scanner. Silent on both ends: the local write reports success, the flush
 * reports success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

describe('supersedes survives the flush (#863)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  /** Bodies of every POST /engrams, in order. */
  let posted: Array<Record<string, unknown>>
  let serverSeq: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-863-'))
    originalFetch = globalThis.fetch
    posted = []
    serverSeq = 0
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  /** Queue writes while the remote is down, then bring it up for the flush. */
  function remoteDown() {
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never
  }
  function remoteUp() {
    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted.push(JSON.parse(init!.body as string))
        serverSeq++
        // The server assigns its OWN id — the whole reason local ids cannot ride.
        return { ok: true, status: 201, json: async () => ({ id: `ENG-GDA-2026-08-11-${String(serverSeq).padStart(3, '0')}` }), text: async () => '' }
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' }
    }) as never
  }

  it('remaps a same-flush supersedes to the server-assigned id', async () => {
    remoteDown()
    const plur = new Plur({ path: dir })
    const original = await plur.learn('the replacement trigger is enabling the nightly timer', { scope: SCOPE, type: 'behavioral' })
    const correction = await plur.learn('there is NO trigger tied to the timer; the trigger is handover', {
      scope: SCOPE, type: 'behavioral', supersedes: [original.id],
    })
    await new Promise(r => setTimeout(r, 60))
    expect(correction.id).not.toBe(original.id)

    remoteUp()
    await plur.flushOutbox()

    expect(posted.length, 'both engrams should have been pushed').toBe(2)
    // The target must go FIRST, or its server id is not yet known.
    const withSupersedes = posted.find(b => Array.isArray(b.supersedes) && (b.supersedes as string[]).length > 0)
    expect(withSupersedes, 'the correction lost its supersedes entirely').toBeDefined()
    const sent = (withSupersedes!.supersedes as string[])[0]
    expect(sent, 'a LOCAL id on the wire means nothing to the server').toMatch(/^ENG-GDA-/)
    expect(sent).not.toBe(original.id)
  })

  it('pushes the superseded target before the engram that supersedes it', async () => {
    remoteDown()
    const plur = new Plur({ path: dir })
    const original = await plur.learn('staging uses port 8080', { scope: SCOPE, type: 'behavioral' })
    await plur.learn('staging uses port 8081, not 8080', {
      scope: SCOPE, type: 'behavioral', supersedes: [original.id],
    })
    await new Promise(r => setTimeout(r, 60))

    remoteUp()
    await plur.flushOutbox()

    expect(posted[0].statement).toContain('8080')
    expect(posted[1].statement).toContain('8081')
  })

  it('REFUSES rather than pushing a half-record when a target cannot be resolved', async () => {
    remoteDown()
    const plur = new Plur({ path: dir })
    const orphan = await plur.learn('a fact that will be superseded', { scope: SCOPE, type: 'behavioral' })
    const correction = await plur.learn('the corrected fact', {
      scope: SCOPE, type: 'behavioral', supersedes: [orphan.id],
    })
    await new Promise(r => setTimeout(r, 60))

    // Remove the target from the store entirely, so it is neither pending nor
    // local — the "cannot be resolved" case.
    const path = join(dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(path, 'utf8')) as { engrams: Array<{ id: string }> }
    doc.engrams = doc.engrams.filter(e => e.id !== orphan.id)
    writeFileSync(path, yaml.dump(doc))

    remoteUp()
    const res = await plur.flushOutbox()

    // Nothing with a dangling supersedes reaches the server.
    const half = posted.find(b => (b as { statement?: string }).statement === 'the corrected fact')
    expect(half, 'a half-record was pushed — this is the bug').toBeUndefined()
    expect(res.expired_warnings.some(w => w.includes(correction.id) && w.includes('NOT pushed'))).toBe(true)
  })

  it('drops — loudly — an edge to a purely local engram rather than blocking forever', async () => {
    remoteDown()
    const plur = new Plur({ path: dir })
    // Target is LOCAL-only: it was never destined for this remote, so the edge
    // is inherently unrepresentable there. Refusing would block a legitimate
    // write permanently.
    const localOnly = await plur.learn('a purely local note', { scope: 'global', type: 'behavioral' })
    await plur.learn('the team-scoped correction of it', {
      scope: SCOPE, type: 'behavioral', supersedes: [localOnly.id],
    })
    await new Promise(r => setTimeout(r, 60))

    remoteUp()
    const res = await plur.flushOutbox()

    const pushedBody = posted.find(b => (b as { statement?: string }).statement === 'the team-scoped correction of it')
    expect(pushedBody, 'a legitimate write must not be blocked').toBeDefined()
    expect(res.expired_warnings.some(w => w.includes('lives only in the local store'))).toBe(true)
  })
})
