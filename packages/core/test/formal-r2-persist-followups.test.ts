/**
 * Formal-verification round 2 (findings/r2-persist.md item 7): two follow-ups
 * of the apply phase.
 *
 *  (a) A `plur sync` pull that rewrites engrams.yaml is a PLUR write too: it
 *      must record the count that landed (owner decision P2), or a legitimate
 *      pulled shrink of >10% — another machine forgot or compacted — is refused
 *      as "shrunk" by the next daily backup.
 *  (b) The heartbeat keeps a lock's age below `T/3 + 30 s` (one git command).
 *      A custom staleThreshold at or below that must be called out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { maybeDailyBackup, _resetBackupProcessState } from '../src/backup.js'
import { saveEngrams } from '../src/engrams.js'
import { startHeartbeat, DEFAULT_STALE_THRESHOLD } from '../src/store/async-lock.js'
import { logger } from '../src/logger.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

function e(n: number) {
  return {
    id: `ENG-2026-09-26-${String(n).padStart(3, '0')}`, statement: `fact ${n}`, type: 'behavioral',
    scope: 'global', status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-26' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  }
}
const day = (n: number) => new Date(Date.UTC(2026, 8, n, 9, 0, 0))

describe('formal-r2-persist: a pulled shrink re-baselines the backup gate', () => {
  isolateGitConfig()
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'plur-r2follow-')); _resetBackupProcessState() })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('the next daily backup after a pulled 50% shrink is taken, not refused', () => {
    const remote = join(base, 'remote.git')
    mkdirSync(remote)
    execSync('git init --bare -q', { cwd: remote })
    const A = join(base, 'A')
    mkdirSync(A)
    mkdirSync(join(A, 'backups'))
    const store = join(A, 'engrams.yaml')
    saveEngrams(store, Array.from({ length: 20 }, (_, i) => e(i + 1)) as any)
    expect(maybeDailyBackup(A, store, day(1)).taken).toBe(true)
    sync(A, remote)

    // Another machine legitimately forgets half the corpus and pushes.
    const B = join(base, 'B')
    execSync(`git clone -q ${remote} ${B}`)
    writeFileSync(join(B, 'engrams.yaml'), yaml.dump({ engrams: Array.from({ length: 10 }, (_, i) => e(i + 1)) }, { lineWidth: 120, noRefs: true, quotingType: '"' }))
    execSync('git add -A && git commit -qm forget && git push -q', { cwd: B })

    const r = sync(A)
    expect(r.message).toContain('pulled')
    _resetBackupProcessState()
    const d2 = maybeDailyBackup(A, store, day(2))
    expect(d2.taken).toBe(true)
  }, 60_000)
})

describe('formal-r2-persist: staleThreshold too short for the heartbeat guarantee', () => {
  it('warns once for a threshold the git-blocked heartbeat cannot keep fresh', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    try {
      const stop1 = startHeartbeat('/nonexistent/a.lock', 'tok-a', 40_000)
      const stop2 = startHeartbeat('/nonexistent/b.lock', 'tok-b', 40_000)
      stop1(); stop2()
      const hits = warn.mock.calls.filter(c => String(c[0]).includes('staleThreshold 40000'))
      expect(hits).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn for the default or for a threshold that clears the bound', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    try {
      startHeartbeat('/nonexistent/c.lock', 'tok-c', DEFAULT_STALE_THRESHOLD)()
      startHeartbeat('/nonexistent/d.lock', 'tok-d', 120_000)()
      expect(warn.mock.calls.filter(c => String(c[0]).includes('staleThreshold'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})
