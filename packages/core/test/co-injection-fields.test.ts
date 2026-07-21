import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'
import { readCoInjections } from '../src/history.js'

// NOTE: the constructor option is `path`, not `root`. Passing `root` leaves
// options.path undefined, so detectPlurStorage falls back to PLUR_PATH or
// ~/.plur — i.e. the developer's real store. Every test here must use `path`.
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-coinject-fields-'))
}

function seed(plur: Plur): void {
  plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
  plur.learn('Nightshift deploys run via systemd restart after a git pull.', { type: 'procedural' })
}

describe('co_injection carries tokens_used and source', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
    seed(plur)
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('records tokens_used as a positive number', () => {
    plur.inject('pnpm install monorepo', { session_id: 's1' })
    const { events } = readCoInjections(dir)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].data.tokens_used).toBeGreaterThan(0)
  })

  it('records the source passed by the caller', () => {
    plur.inject('pnpm install monorepo', { session_id: 's1', source: 'hook' })
    expect(readCoInjections(dir).events[0].data.source).toBe('hook')
  })

  it('defaults source to "inject" when the caller omits it', () => {
    plur.inject('pnpm install monorepo', { session_id: 's1' })
    expect(readCoInjections(dir).events[0].data.source).toBe('inject')
  })

  it('preserves session_id', () => {
    plur.inject('pnpm install monorepo', { session_id: 'sess-abc' })
    expect(readCoInjections(dir).events[0].data.session_id).toBe('sess-abc')
  })

  it('still records ids and query_hash', () => {
    plur.inject('pnpm install monorepo', { session_id: 's1' })
    const d = readCoInjections(dir).events[0].data
    expect(d.ids.length).toBeGreaterThan(0)
    expect(d.query_hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('accepts every documented source value', () => {
    for (const src of ['session_start', 'inject', 'hook'] as const) {
      plur.inject('pnpm install monorepo', { session_id: `s-${src}`, source: src })
    }
    const bySession = new Map(
      readCoInjections(dir).events.map(e => [e.data.session_id, e.data.source]),
    )
    expect(bySession.get('s-session_start')).toBe('session_start')
    expect(bySession.get('s-inject')).toBe('inject')
    expect(bySession.get('s-hook')).toBe('hook')
  })
})

describe('readCoInjections is defensive', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function writeRaw(obj: unknown): void {
    const month = new Date().toISOString().slice(0, 7)
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true })
    fs.appendFileSync(path.join(dir, 'history', `${month}.jsonl`), JSON.stringify(obj) + '\n')
  }

  it('tolerates legacy events with no tokens_used or source', () => {
    writeRaw({
      event: 'co_injection', engram_id: 'INJ-legacy', timestamp: new Date().toISOString(),
      data: { ids: ['ENG-1'], query_hash: 'abcdef0123456789' },
    })
    const legacy = readCoInjections(dir).events.find(e => e.injection_id === 'INJ-legacy')
    expect(legacy).toBeDefined()
    expect(legacy!.data.tokens_used).toBeUndefined()
    expect(legacy!.data.source).toBeUndefined()
  })

  it('skips malformed lines without throwing and counts them', () => {
    const month = new Date().toISOString().slice(0, 7)
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true })
    fs.appendFileSync(path.join(dir, 'history', `${month}.jsonl`), '{not json\n')
    writeRaw({
      event: 'co_injection', engram_id: 'INJ-ok', timestamp: new Date().toISOString(),
      data: { ids: ['ENG-1'], query_hash: 'abcdef0123456789' },
    })
    const r = readCoInjections(dir)
    expect(r.events).toHaveLength(1)
    expect(() => readCoInjections(dir)).not.toThrow()
  })

  it('drops a payload with no ids array and counts it as skipped', () => {
    writeRaw({
      event: 'co_injection', engram_id: 'INJ-bad', timestamp: new Date().toISOString(),
      data: { query_hash: 'abcdef0123456789' },
    })
    const r = readCoInjections(dir)
    expect(r.events).toHaveLength(0)
    expect(r.skipped).toBe(1)
  })

  it('drops non-string ids so they can never reach a renderer', () => {
    writeRaw({
      event: 'co_injection', engram_id: 'INJ-nullid', timestamp: new Date().toISOString(),
      data: { ids: ['ENG-1', null, 42], query_hash: 'abcdef0123456789' },
    })
    const r = readCoInjections(dir)
    expect(r.events[0].data.ids).toEqual(['ENG-1'])
    expect(r.skipped).toBe(1)
  })

  it('coerces an unrecognised source to "unknown"', () => {
    writeRaw({
      event: 'co_injection', engram_id: 'INJ-weird', timestamp: new Date().toISOString(),
      data: { ids: ['ENG-1'], query_hash: 'abcdef0123456789', source: 'costing' },
    })
    expect(readCoInjections(dir).events[0].data.source).toBe('unknown')
  })

  it('drops an event with an unparseable timestamp', () => {
    writeRaw({
      event: 'co_injection', engram_id: 'INJ-badts', timestamp: 'not-a-date',
      data: { ids: ['ENG-1'], query_hash: 'abcdef0123456789' },
    })
    const r = readCoInjections(dir)
    expect(r.events).toHaveLength(0)
    expect(r.skipped).toBe(1)
  })

  it('returns an empty result when no history directory exists', () => {
    expect(readCoInjections(dir)).toEqual({ events: [], skipped: 0 })
  })

  it('writes no event when nothing was injected', () => {
    const emptyStore = new Plur({ path: dir })
    emptyStore.inject('nothing in this store matches anything at all', { session_id: 's1' })
    expect(readCoInjections(dir).events).toHaveLength(0)
  })
})
