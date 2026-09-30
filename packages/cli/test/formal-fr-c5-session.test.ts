/**
 * Formal-verification replays, field-report cluster 5 (CLI hook lifecycle):
 * session keys (decision H1) and the hook state directory (OPEN CONFLICT H).
 * Model: spec/formal/PlurSpec/R2CLI.lean §FR5.Key, §FR5.Dir.
 * Findings: spec/formal/findings/r2-cli.md, "Field report cluster 5".
 *
 * `it.fails` marks a CONFIRMED defect: the body asserts the intended behaviour
 * and fails on the current code. When the owning PR fixes it, vitest reports
 * the test as unexpectedly passing — drop `.fails` then.
 * Plain `it` pins a property the model proves (the good case is reachable).
 *
 * TMPDIR, HOME and PLUR_PATH point into a temp dir; never the real ~/.plur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync, lstatSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hookSessionDir, writeSessionTask, readSessionTask } from '../src/lib/session-task.js'
import { hookSessionKey, legacyHookSessionKeys } from '../src/lib/session-key.js'

const ENV_KEYS = ['TMPDIR', 'HOME', 'PLUR_PATH', 'CLAUDE_SESSION_ID'] as const

describe('formal field-report cluster 5 — session keys and state dir', () => {
  let root: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-fr-c5-'))
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    mkdirSync(join(root, 'tmp'))
    mkdirSync(join(root, 'home'))
    mkdirSync(join(root, 'store'))
    process.env.TMPDIR = join(root, 'tmp')
    process.env.HOME = join(root, 'home')
    process.env.PLUR_PATH = join(root, 'store')
    delete process.env.CLAUDE_SESSION_ID
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(root, { recursive: true, force: true })
  })

  describe('H1: one key (Key.h1_same_payload)', () => {
    it('the same payload id gives the same key whatever CLAUDE_SESSION_ID says', () => {
      const id = 'aaaaaaaa-0000-4000-8000-00000000c5c5'
      const a = hookSessionKey(id)
      process.env.CLAUDE_SESSION_ID = 'some-other-session'
      expect(hookSessionKey(id)).toBe(a)
      expect(a).toBe(id)
    })

    it('readers keep the legacy writer forms (Key.legacy_sid_found, legacy_envfirst_found)', () => {
      const id = 'aaaaaaaa-0000-4000-8000-00000000c5c6'
      process.env.CLAUDE_SESSION_ID = 'env.sess'
      const legacy = legacyHookSessionKeys(id)
      expect(legacy).toContain(`sid-${id}`)
      expect(legacy).toContain('envsess') // main's / #1228's env-first stripped key
    })

    // CONFIRMED (minor, Key.legacy_ppid_missed_with_env): with CLAUDE_SESSION_ID
    // set, a marker keyed by the bare ppid (released builds; #1228 without a
    // payload id) is not among the marker reader's keys. hook-session-end's
    // checkpoint reader has the ppid form; hook-inject's marker reader does not.
    it.fails('with CLAUDE_SESSION_ID set, the marker reader still tries the ppid key', () => {
      process.env.CLAUDE_SESSION_ID = 'env-sess'
      const keys = [hookSessionKey('payload-id'), ...legacyHookSessionKeys('payload-id')]
      expect(keys).toContain(String(process.ppid))
    })
  })

  describe('state dir (Dir.conflict_H_unique)', () => {
    it('a planted shared dir is refused and state goes to a private 0700 dir (dirH, good case)', () => {
      const evil = join(root, 'evil')
      mkdirSync(evil)
      symlinkSync(evil, join(root, 'tmp', 'plur-sessions'))
      const dir = hookSessionDir()
      expect(dir).toBe(join(root, 'store', 'hook-sessions'))
      expect(lstatSync(dir).isSymbolicLink()).toBe(false)
      expect(statSync(dir).mode & 0o077).toBe(0)
      writeSessionTask('s1', 'first prompt')
      expect(readSessionTask('s1')).toBe('first prompt')
      expect(readdirSync(evil)).toEqual([])
    })

    // CONFIRMED (Dir.dir1395_unsafe): hookSessionDir computes the fallback's
    // ensureSessionDir verdict and returns the fallback anyway. With both the
    // shared dir and the fallback planted (PLUR_PATH in a shared location), the
    // session task — a copy of the user's prompt — is written through the
    // symlink into a directory the user does not control.
    it('state never lands in a refused fallback dir', () => {
      const evilShared = join(root, 'evil-shared')
      const evilFallback = join(root, 'evil-fallback')
      mkdirSync(evilShared)
      mkdirSync(evilFallback)
      symlinkSync(evilShared, join(root, 'tmp', 'plur-sessions'))
      symlinkSync(evilFallback, join(root, 'store', 'hook-sessions'))
      writeSessionTask('s2', 'secret prompt text')
      expect(readdirSync(evilShared)).toEqual([])
      expect(readdirSync(evilFallback)).toEqual([])
    })
  })
})
