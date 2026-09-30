/**
 * Formal-verification gap closure, 2026-09-27: the final full run lost one
 * telemetry event under load (159 of 160). A recorder that could not take the
 * counters lock within ~1 s DROPPED its event — "telemetry never blocks" was
 * kept, "events are conserved" (PlurSpec.R2Retrieval.Telemetry) was not.
 * Now a contended event is appended to a spill file (a short O_APPEND write,
 * no lock) and folded in by the next writer that holds the lock: still never
 * blocking, and nothing lost. Contention is forced by holding the real lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordEvent } from '../src/telemetry-counters.js'
import { withLock } from '../src/sync.js'

let dir: string
let base: Record<string, any>
const day = () => new Date('2026-05-10T18:00:00Z')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-telemetry-spill-'))
  base = {
    env: { PLUR_TELEMETRY: 'on' },
    configPath: join(dir, 'telemetry.json'),
    countersPath: join(dir, 'counters.json'),
    installIdPath: join(dir, 'install-id'),
    pendingDir: join(dir, 'pending'),
    now: day,
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const counters = () => JSON.parse(readFileSync(base.countersPath, 'utf8'))

describe('a contended telemetry event is kept, not dropped', () => {
  it('an event recorded while another holder has the lock is counted once the lock frees', () => {
    recordEvent('learn', base) // counters exist: learn 1
    const t0 = Date.now()
    withLock(base.countersPath, () => {
      recordEvent('learn', base) // contended: must not block the caller for long, and must not be lost
    })
    expect(Date.now() - t0).toBeLessThan(5_000)
    recordEvent('recall', base) // the next locked writer folds in what was spilled
    const c = counters()
    expect(c.learn).toBe(2)
    expect(c.recall).toBe(1)
    expect(c.session).toBe(1) // the spilled learn does not open a second session
  })

  it('a contended event spills at once instead of spinning through a retry ladder (#1240)', () => {
    recordEvent('learn', base)
    let waited = Infinity
    withLock(base.countersPath, () => {
      const t0 = Date.now()
      expect(recordEvent('learn', base)).toBe(false) // spilled, not counted yet
      waited = Date.now() - t0
    })
    // The old ladder (8 retries from 2 ms) spun for ~510 ms before spilling.
    expect(waited).toBeLessThan(100)
    recordEvent('recall', base)
    expect(counters().learn).toBe(2)
  })

  it('good case: without contention nothing is spilled', () => {
    recordEvent('learn', base)
    recordEvent('learn', base)
    expect(counters().learn).toBe(2)
  })
})
