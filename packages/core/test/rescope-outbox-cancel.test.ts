/**
 * #848 — a rescope must cancel the pending delivery to the store it moved away from.
 *
 * A failed remote write queues the engram with `structured_data._outbox` naming
 * the target url + scope. `rescope` rewrote the local scope and left that entry
 * untouched, so when the original store recovered the engram was delivered to
 * the store the user had explicitly moved it away from — silently undoing the
 * rescope, arbitrarily later.
 *
 * The window is unbounded: the queue only flushes when the store comes back. And
 * it bites in exactly the situation the outbox exists for — the store being
 * unreachable is what makes the misroute recoverable, and also what leaves the
 * stale entry sitting there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'

describe('rescope cancels a stale outbox entry (#848)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rescope-outbox-'))
    originalFetch = globalThis.fetch
    // Store is unreachable: every write fails, so learn() queues to the outbox.
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as any
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: 'group:acme/team', shared: true, readonly: false }],
      index: false,
    }))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write an engram destined for the unreachable remote, so it lands queued. */
  async function queuedEngram(plur: Plur) {
    const e = await plur.learn('a team fact written while the store was down', {
      scope: 'group:acme/team', type: 'behavioral',
    })
    await new Promise(r => setTimeout(r, 50))   // let the fire-and-forget push settle
    return e
  }

  function outboxOf(id: string): { target_url?: string; target_scope?: string } | undefined {
    const doc = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as
      { engrams: Array<{ id: string; scope: string; structured_data?: { _outbox?: any } }> }
    return doc.engrams.find(e => e.id === id)?.structured_data?._outbox
  }

  it('drops the queued delivery when the engram is moved to a local scope', async () => {
    const plur = new Plur({ path: dir })
    const e = await queuedEngram(plur)
    expect(outboxOf(e.id), 'precondition: the write should have queued').toBeDefined()

    const { results } = await plur.rescope(e.id, 'global')

    expect(results[0].status).toBe('rescoped')
    expect(results[0].action).toBe('local_rewrite')
    // The whole point: no queued delivery survives to re-route it later.
    expect(outboxOf(e.id), 'a pending delivery to the old store survived the rescope').toBeUndefined()
  })

  it('reports the cancellation rather than doing it quietly', async () => {
    const plur = new Plur({ path: dir })
    const e = await queuedEngram(plur)

    const { results } = await plur.rescope(e.id, 'global')

    // A caller cannot otherwise distinguish a rescope that cancelled a queued
    // delivery from one that did not.
    expect(results[0].cancelled_outbox).toEqual({
      target_url: REMOTE,
      target_scope: 'group:acme/team',
    })
  })

  it('records the cancellation in history', async () => {
    const plur = new Plur({ path: dir })
    const e = await queuedEngram(plur)
    await plur.rescope(e.id, 'global')

    const { readdirSync } = await import('fs')
    const hist = readdirSync(join(dir, 'history'))
      .filter(f => f.endsWith('.jsonl'))
      .flatMap(f => readFileSync(join(dir, 'history', f), 'utf8').split('\n').filter(Boolean))
      .map(l => JSON.parse(l))
      .filter(ev => ev.engram_id === e.id && ev.event === 'engram_rescoped')

    expect(hist).toHaveLength(1)
    expect(hist[0].data.cancelled_outbox?.target_url).toBe(REMOTE)
  })

  it('dry_run discloses the queued delivery without mutating anything', async () => {
    const plur = new Plur({ path: dir })
    const e = await queuedEngram(plur)

    const { results } = await plur.rescope(e.id, 'global', { dry_run: true })

    expect(results[0].dry_run).toBe(true)
    expect(results[0].cancelled_outbox?.target_url).toBe(REMOTE)
    // Nothing actually changed.
    expect(outboxOf(e.id), 'dry_run must not cancel the delivery').toBeDefined()
  })

  it('leaves an engram with no queued delivery untouched', async () => {
    const plur = new Plur({ path: dir })
    // Purely local write — never had an outbox entry.
    const e = await plur.learn('a purely local fact', { scope: 'global', type: 'behavioral' })

    const { results } = await plur.rescope(e.id, 'project:demo')

    expect(results[0].status).toBe('rescoped')
    expect(results[0].cancelled_outbox, 'nothing was queued, so nothing to report').toBeUndefined()
  })
})
