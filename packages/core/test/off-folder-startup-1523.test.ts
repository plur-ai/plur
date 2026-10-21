// #1523: constructing the engine in a folder where memory is off must not touch
// memory. The one-time legacy tension migration (#156) used to run from the
// constructor regardless of the folder, reading the whole store and stamping
// `.tensions-purged` in the PLUR home.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

function engram(id: string, conflicts: string[] = []): Record<string, unknown> {
  return {
    id, version: 2, status: 'active', consolidated: false, type: 'behavioral',
    scope: 'global', visibility: 'private', statement: `statement ${id}`,
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_anchors: [], associations: [], derivation_count: 1,
    pack: null, abstract: null, derived_from: null, polarity: null,
    relations: { broader: [], narrower: [], related: [], supersedes: [], superseded_by: [], conflicts },
  }
}

describe('engine startup in an off folder (#1523)', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setup(): { home: string; off: string; other: string; store: string } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-off-startup-home-')))
    const off = realpathSync(mkdtempSync(join(tmpdir(), 'plur-off-startup-off-')))
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'plur-off-startup-other-')))
    dirs.push(home, off, other)
    writeFileSync(join(home, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    const store = join(home, 'engrams.yaml')
    // A legacy conflict: a writable instance in an ordinary folder WOULD purge it.
    writeFileSync(store, yaml.dump({ engrams: [engram('ENG-2026-01-01-001', ['ENG-2026-01-01-002']), engram('ENG-2026-01-01-002')] }))
    writeFileSync(join(home, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${off}"\n    plur: off\n`)
    return { home, off, other, store }
  }

  it('does not run the startup migration or stamp its sentinel (cwd option)', async () => {
    const { home, off, store } = setup()
    const before = readFileSync(store, 'utf8')
    const plur = new Plur({ path: home, cwd: off })
    await plur.ready()
    expect(existsSync(join(home, '.tensions-purged'))).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('does not run the startup migration when the process folder is off', async () => {
    const { home, off, store } = setup()
    vi.spyOn(process, 'cwd').mockReturnValue(off)
    const before = readFileSync(store, 'utf8')
    const plur = new Plur({ path: home })
    await plur.ready()
    expect(existsSync(join(home, '.tensions-purged'))).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('does not read the store at startup in an off folder', async () => {
    const { home, off } = setup()
    const spy = vi.spyOn(Plur.prototype, 'purgeTensions')
    const plur = new Plur({ path: home, cwd: off })
    await plur.ready()
    expect(spy).not.toHaveBeenCalled()
  })

  it('leaves the migration for the next start outside the off folder', async () => {
    const { home, off, other, store } = setup()
    await new Plur({ path: home, cwd: off }).ready()
    expect(existsSync(join(home, '.tensions-purged'))).toBe(false)
    await new Plur({ path: home, cwd: other }).ready()
    expect(existsSync(join(home, '.tensions-purged'))).toBe(true)
    const engrams = (yaml.load(readFileSync(store, 'utf8')) as { engrams: Array<{ relations?: { conflicts?: string[] } }> }).engrams
    expect(engrams[0].relations?.conflicts ?? []).toEqual([])
  })
})
