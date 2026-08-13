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
    // Explicit Response-shaped return, annotated: an inline object literal with
    // `text: async () => ''` makes TS infer the method's type from its own
    // return expression, which `typecheck:tests` rejects as implicit-any
    // recursion (TS7023).
    const res = (status: number, body: unknown): Response => ({
      ok: true,
      status,
      json: async (): Promise<unknown> => body,
      text: async (): Promise<string> => '',
    } as unknown as Response)

    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted.push(JSON.parse(init!.body as string))
        serverSeq++
        // The server assigns its OWN id — the whole reason local ids cannot ride.
        return res(201, { id: `ENG-GDA-2026-08-11-${String(serverSeq).padStart(3, '0')}` })
      }
      return res(200, { rows: [], total_count: 0 })
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

/**
 * Chains deeper than two, and edges whose target left in an EARLIER flush.
 *
 * Both were asserted rather than tested. #863 claimed "one stable partial
 * ordering is enough … a deeper chain resolves across successive flushes";
 * all four of its fixtures used exactly two pending engrams, and the
 * 2026-08-13 panel showed both halves of the claim to be false:
 *
 *   - the comparator `aDependsOnB - bDependsOnA` is non-transitive, so a
 *     three-node chain could be ordered arbitrarily, and
 *   - a target flushed in an earlier run has no local row and no entry in the
 *     per-flush map, so its dependent failed identically on every subsequent
 *     flush while being told to "flush again once X has been pushed".
 */
describe('supersedes ordering for chains and across flushes (#863 follow-up)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posted: Array<Record<string, unknown>>
  let serverSeq: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-863-chain-'))
    originalFetch = globalThis.fetch
    posted = []
    serverSeq = 0
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  const down = () => { globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never }
  const up = () => {
    const res = (status: number, body: unknown): Response => ({
      ok: true, status,
      json: async (): Promise<unknown> => body,
      text: async (): Promise<string> => '',
    } as unknown as Response)
    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted.push(JSON.parse(init!.body as string))
        serverSeq++
        return res(201, { id: `ENG-GDA-2026-08-11-${String(serverSeq).padStart(3, '0')}` })
      }
      return res(200, { rows: [], total_count: 0 })
    }) as never
  }

  it('orders a three-deep chain so every edge resolves in one flush', async () => {
    // A supersedes B supersedes C. The correct push order is C, B, A — the
    // REVERSE of the order they sit in the store, which is what makes this the
    // discriminating case. The edges are wired after creation because a
    // supersedes target must already exist, and wiring them at creation time
    // would put the store in topological order already and let any comparator
    // pass.
    down()
    const plur = new Plur({ path: dir })
    const a = await plur.learn('the final word on the timer claim', { scope: SCOPE, type: 'behavioral' })
    const b = await plur.learn('a first correction to the timer claim', { scope: SCOPE, type: 'behavioral' })
    const c = await plur.learn('the original claim about the timer', { scope: SCOPE, type: 'behavioral' })
    await new Promise(r => setTimeout(r, 60))
    for (const [from, to] of [[a, b], [b, c]] as const) {
      const row = (await plur.getById(from.id))!
      ;(row as unknown as { relations: Record<string, unknown> }).relations = {
        ...((row as unknown as { relations?: Record<string, unknown> }).relations ?? {}),
        supersedes: [to.id],
      }
      await plur.updateEngram(row)
    }

    up()
    const res = await plur.flushOutbox()

    expect(res.failed, `chain stalled: ${res.expired_warnings.join(' | ')}`).toBe(0)
    expect(posted.length).toBe(3)
    expect(posted.map(p => p.statement)).toEqual([c.statement, b.statement, a.statement])
    // Every pushed edge points at a SERVER id, never a local one.
    for (const p of posted.slice(1)) {
      const sup = (p.supersedes as string[] | undefined) ?? []
      expect(sup.length, 'the correction lost its supersedes entirely').toBeGreaterThan(0)
      for (const t of sup) expect(t).toMatch(/^ENG-GDA-/)
    }
  })

  it('resolves an edge whose target was pushed in an EARLIER flush', async () => {
    down()
    const plur = new Plur({ path: dir })
    const target = await plur.learn('the statement that will be corrected later', { scope: SCOPE, type: 'behavioral' })
    // A local-only engram, minted AFTER the target, purely to hold the id
    // sequence up. Without it the target's local row is spliced out on flush,
    // the store is empty again, and the correction is minted the SAME id the
    // target had — which is #816 (ids are derived from the store's high-water
    // mark, and the mark is not persisted) and would make this test assert
    // something other than what it is about.
    await plur.learn('an unrelated local note', { scope: 'global', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 60))

    // Flush 1: the target goes, and its local row is spliced out.
    up()
    await plur.flushOutbox()
    expect(posted.length).toBe(1)
    const serverId = 'ENG-GDA-2026-08-11-001'

    // Flush 2: a correction queued afterwards still names the LOCAL id.
    down()
    const correction = await plur.learn('the corrected statement', {
      scope: SCOPE, type: 'behavioral', supersedes: [target.id],
    })
    await new Promise(r => setTimeout(r, 60))
    expect(correction.id).not.toBe(target.id)

    up()
    const res = await plur.flushOutbox()

    expect(
      res.failed,
      `permanently stalled — the remediation "flush again once ${target.id} has been pushed" `
      + `cannot be followed, because it already was: ${res.expired_warnings.join(' | ')}`,
    ).toBe(0)
    expect(posted.length).toBe(2)
    // The wire shape flattens `relations.supersedes` to a top-level field.
    expect(posted[1].supersedes, 'the edge still names a dead local id').toEqual([serverId])
  })

  it('a mutual supersedes is refused and reported, not silently dropped', async () => {
    // A cycle has no valid order. The engrams must still be ATTEMPTED — a
    // node that never enters the loop disappears from the flush entirely,
    // which is worse than a loud refusal.
    down()
    const plur = new Plur({ path: dir })
    const x = await plur.learn('one side of a mutual correction', { scope: SCOPE, type: 'behavioral' })
    const y = await plur.learn('the other side of a mutual correction', {
      scope: SCOPE, type: 'behavioral', supersedes: [x.id],
    })
    await new Promise(r => setTimeout(r, 60))
    // Close the cycle by hand — nothing in the API creates one.
    const stored = (await plur.getById(x.id))!
    ;(stored as unknown as { relations: Record<string, unknown> }).relations = {
      ...((stored as unknown as { relations?: Record<string, unknown> }).relations ?? {}),
      supersedes: [y.id],
    }
    await plur.updateEngram(stored)

    up()
    const res = await plur.flushOutbox()

    // One of the two cannot resolve its edge; it must be reported, and the
    // other must still get through.
    expect(res.flushed + res.failed, 'a cycle member vanished from the flush').toBe(2)
    expect(res.failed).toBeGreaterThan(0)
    expect(res.expired_warnings.some(w => w.includes('NOT pushed'))).toBe(true)
  })
})
