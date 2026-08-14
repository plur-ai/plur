/**
 * #667 — the outbox must be inspectable without reverse-engineering the store.
 *
 * The mechanism worked and was invisible. It is not a file or a queue
 * directory: it is `structured_data._outbox` nested inside ordinary engrams in
 * `engrams.yaml`. So a user whose team store was unreachable had queued writes
 * with no supported way to see them, and the only prose describing the pattern
 * lived inside an engram rather than in any doc.
 *
 * The security property is asserted first because it is the one that cannot be
 * fixed later: these entries are rendered into agent context and CLI output,
 * so a credentialed endpoint must not be in them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

describe('listOutbox (#667)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-inspect-'))
    originalFetch = globalThis.fetch
    // Unreachable remote, so team-scoped writes queue instead of landing.
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'super-secret-token', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  async function queue(plur: Plur, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await plur.learn(`queued team fact number ${i}`, { scope: SCOPE, type: 'behavioral' })
    }
    await new Promise(r => setTimeout(r, 60))
  }

  it('never returns the target URL or the token', async () => {
    // The reason `listOutbox` omits `target_url` at the SOURCE rather than
    // redacting it per call site: there are several renderers (MCP tool, CLI
    // text, CLI JSON) and each one would have to remember.
    const plur = new Plur({ path: dir })
    await queue(plur, 2)

    const entries = await plur.listOutbox()
    expect(entries.length).toBe(2)
    const serialized = JSON.stringify(entries)
    expect(serialized, 'the token reached an agent-visible surface').not.toContain('super-secret-token')
    expect(serialized, 'the endpoint URL reached an agent-visible surface').not.toContain('plur.example.com')
    for (const e of entries) {
      expect(e).not.toHaveProperty('target_url')
      expect(e).not.toHaveProperty('token')
    }
  })

  it('reports the fields a human needs to act: scope, age, attempts, last error', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 1)

    const [entry] = await plur.listOutbox()
    expect(entry.target_scope, 'without this, "which store is behind?" is unanswerable').toBe(SCOPE)
    expect(entry.attempt_count).toBeGreaterThanOrEqual(0)
    expect(entry.age_days, 'a just-queued write is 0 days old, never NaN').toBe(0)
    expect(entry.queued_at).not.toBe('')
  })

  it('agrees with outboxCount, so the two cannot report different queues', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 3)
    expect((await plur.listOutbox()).length).toBe(await plur.outboxCount())
  })

  it('is empty when nothing is queued, rather than throwing', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('a purely local fact', { scope: 'global', type: 'behavioral' })
    expect(await plur.listOutbox()).toEqual([])
  })

  it('excludes retired engrams — a retired write is cancelled, not queued', async () => {
    // `forget()` strips `_outbox` on retirement so a queued engram cannot be
    // resurrected on the remote (#766). The inspector must agree with that,
    // or it reports work that will never happen.
    const plur = new Plur({ path: dir })
    await queue(plur, 1)
    const [entry] = await plur.listOutbox()
    await plur.forget(entry.id, 'no longer wanted', { scope: 'primary', force: true })
    expect(await plur.listOutbox()).toEqual([])
  })

  it('reports age 0 rather than NaN for a malformed timestamp', async () => {
    // These numbers are rendered. NaN in a report reads as a bug in the
    // reporter rather than as the missing data it actually is.
    const plur = new Plur({ path: dir })
    await queue(plur, 1)
    const [entry] = await plur.listOutbox()
    const raw = (await plur.getById(entry.id))!
    ;(raw as unknown as { structured_data: { _outbox: Record<string, unknown> } })
      .structured_data._outbox.queued_at = 'not a date'
    await plur.updateEngram(raw)

    const [after] = await plur.listOutbox()
    expect(Number.isNaN(after.age_days)).toBe(false)
    expect(after.age_days).toBe(0)
  })
})
