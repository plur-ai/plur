/**
 * config.yaml persist paths run under withLock (scope-audit 2026-07-24).
 *
 * persistStores and persistDismissedScopes are read-modify-write cycles on
 * config.yaml; engrams.yaml has always taken `withLock` for the same shape,
 * but the config paths ran bare — two concurrent persists (an MCP
 * session_start metadata sync racing a CLI `plur stores add`) could each
 * re-read the file and last-writer-wins away the other's change. These tests
 * pin the lockfile discipline: the lock is taken (and released) around the
 * write, and a stale lock from a dead process is broken rather than wedging
 * every config mutation forever.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function makeDir(config: Record<string, unknown> = {}): { dir: string; plur: Plur } {
  const dir = mkdtempSync(join(tmpdir(), 'plur-config-lock-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, ...config }, { noRefs: true }))
  return { dir, plur: new Plur({ path: dir }) }
}

describe('config.yaml persist paths take withLock (scope-audit 2026-07-24)', () => {
  it('addStore (persistStores) releases the lock and persists the entry', () => {
    const { dir, plur } = makeDir()
    plur.addStore('/tmp/lock-test-engrams.yaml', 'project:lock-test')
    // Write landed…
    const cfg = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
    expect(cfg.stores.map((s: any) => s.scope)).toContain('project:lock-test')
    // …and the lock was released (no orphan lockfile wedging future writes).
    expect(existsSync(join(dir, 'config.yaml.lock'))).toBe(false)
  })

  it('a STALE lock (dead process) is broken — the write goes through', () => {
    const { dir, plur } = makeDir()
    const lockPath = join(dir, 'config.yaml.lock')
    writeFileSync(lockPath, '999999')  // pid of a long-gone process
    // Age it past withLock's stale threshold (10s).
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)

    plur.addStore('/tmp/lock-test-engrams.yaml', 'project:lock-test')
    const cfg = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
    expect(cfg.stores.map((s: any) => s.scope)).toContain('project:lock-test')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('dismissScope (persistDismissedScopes) releases the lock and persists', () => {
    const { dir, plur } = makeDir()
    plur.dismissScope('group:plur/x')
    const cfg = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
    expect(cfg.dismissed_scopes).toEqual(['group:plur/x'])
    expect(existsSync(join(dir, 'config.yaml.lock'))).toBe(false)
  })
})
