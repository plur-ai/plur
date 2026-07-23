import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'

// Constructor option is `path`, NOT `root` — see co-injection-fields.test.ts.
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-receipt-io-'))
}

describe('Plur.receipt()', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns an empty receipt for a fresh store', () => {
    const r = plur.receipt()
    expect(r.stored.total).toBe(0)
    expect(r.retrieved.retrievals).toBe(0)
    expect(r.coverage.source).toBe('none')
  })

  it('reflects a real injection end to end', () => {
    plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
    plur.inject('pnpm install monorepo', { session_id: 's1', source: 'hook' })

    const r = plur.receipt()
    expect(r.stored.own).toBe(1)
    expect(r.retrieved.retrievals).toBe(1)
    expect(r.retrieved.engrams).toBe(1)
    expect(r.retrieved.activation_rate).toBe(1)
    expect(r.sources.hook).toBe(1)
    expect(r.coverage.source).toBe('co_injection')
    expect(r.coverage.session_id_coverage).toBe(1)
  })

  it('counts an engram retrieved in two sessions as two pairs', () => {
    plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
    plur.inject('pnpm install', { session_id: 's1' })
    plur.inject('pnpm install', { session_id: 's2' })

    const r = plur.receipt()
    expect(r.retrieved.engram_session_pairs).toBe(2)
    expect(r.window.sessions).toBe(2)
  })

  it('honours the days window', () => {
    plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
    plur.inject('pnpm install', { session_id: 's1' })
    const r = plur.receipt({ days: 30 })
    expect(r.retrieved.retrievals).toBe(1)
    expect(r.window.windowed).toBe(true)
    expect(r.window.requested_days).toBe(30)
  })

  it('does not throw when the history directory is absent', () => {
    fs.rmSync(path.join(dir, 'history'), { recursive: true, force: true })
    expect(() => plur.receipt()).not.toThrow()
  })

  it('counts never-retrieved engrams as dormant', () => {
    plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
    plur.learn('Nightshift deploys run via systemd restart after a git pull.', { type: 'procedural' })
    plur.inject('pnpm install', { session_id: 's1' })

    const r = plur.receipt()
    expect(r.stored.total).toBe(2)
    expect(r.dormant.never_retrieved).toBeGreaterThanOrEqual(1)
  })

  it('own + pack always equals total', () => {
    plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
    const r = plur.receipt()
    expect(r.stored.own + r.stored.pack).toBe(r.stored.total)
  })
})
