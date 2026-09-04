import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, symlinkSync, utimesSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ensureSessionDir,
  sessionDirSafeToSweep,
  cleanupStaleSessionFiles,
  markSessionStarted,
  sentinelPath,
  sessionDir,
} from '../src/lib/codex-hook-io.js'
import { incrementCounter as cursorIncrementCounter } from '../src/lib/cursor-hook-io.js'

/**
 * #1060: the 0.19.0 audit showed the Antigravity adapter's tmp hardening
 * (0700 dirs, 0600 files, symlink/ownership vetting) was never applied to
 * the Codex and Cursor families — replaying the Codex adapter's filesystem
 * calls against a pre-planted symlink wrote through it and, after seven
 * days, DELETED the victim's files via the stale sweep. The hardening now
 * lives in one shared ensureSessionDir/sessionDirSafeToSweep; these tests
 * pin the behaviours the agy suite already pins, on the shared code and the
 * previously unguarded families.
 */

const posixOnly = process.platform === 'win32' ? it.skip : it

describe('ensureSessionDir (shared)', () => {
  let scratch: string
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'plur-1060-')) })
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

  posixOnly('creates the directory 0700', () => {
    const dir = join(scratch, 'sessions')
    expect(ensureSessionDir(dir)).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  posixOnly('refuses a pre-planted symlink — mkdirSync alone accepts it', () => {
    const victim = join(scratch, 'victim')
    expect(ensureSessionDir(victim)).toBe(true)
    const link = join(scratch, 'sessions')
    symlinkSync(victim, link)
    expect(ensureSessionDir(link)).toBe(false)
  })

  posixOnly('tightens a pre-existing 0755 dir in place (the pre-hardening upgrade case)', () => {
    const dir = join(scratch, 'sessions')
    expect(ensureSessionDir(dir)).toBe(true)
    // Loosen it to what every install before the hardening created.
    chmodSync(dir, 0o755)
    expect(ensureSessionDir(dir)).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('stale-file sweep refuses untrusted directories', () => {
  let scratch: string
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'plur-1060-sweep-')) })
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

  posixOnly('does not delete a victim file through a symlinked dir — the #1060 deletion primitive', () => {
    const victim = join(scratch, 'victim')
    ensureSessionDir(victim)
    const precious = join(victim, 'precious.marker')
    writeFileSync(precious, 'x')
    const old = Date.now() / 1000 - 8 * 24 * 60 * 60
    utimesSync(precious, old, old)

    const link = join(scratch, 'plur-codex-sessions')
    symlinkSync(victim, link)
    expect(sessionDirSafeToSweep(link)).toBe(false)
    cleanupStaleSessionFiles(Date.now(), link)
    expect(existsSync(precious)).toBe(true)
  })

  it('still sweeps a legitimate directory', () => {
    const dir = join(scratch, 'sessions')
    ensureSessionDir(dir)
    const stale = join(dir, 'old.marker')
    writeFileSync(stale, 'x')
    const old = Date.now() / 1000 - 8 * 24 * 60 * 60
    utimesSync(stale, old, old)
    cleanupStaleSessionFiles(Date.now(), dir)
    expect(existsSync(stale)).toBe(false)
  })
})

describe('codex family file modes', () => {
  // The real (per-user on macOS/dev machines) session dir — same approach the
  // agy suite takes for its 0600 assertion.
  posixOnly('writes the sentinel 0600', () => {
    const sid = 'hardening-1060-test-session'
    markSessionStarted(sid)
    expect(statSync(sentinelPath(sid)).mode & 0o777).toBe(0o600)
    expect(statSync(sessionDir()).mode & 0o777).toBe(0o700)
    rmSync(sentinelPath(sid), { force: true })
  })
})

describe('cursor counter fail-open (the bonus instance)', () => {
  it('reports an unwritable counter as exceeded instead of throwing out of the hook', () => {
    const missing = join(tmpdir(), 'plur-1060-no-such-dir', 'nested', 'counter')
    expect(cursorIncrementCounter(missing)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
