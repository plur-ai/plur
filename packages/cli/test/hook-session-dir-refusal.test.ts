/**
 * The hook state directory policy (formal conflict H, spec/formal R2CLI §FR5
 * `Dir.conflict_H_unique`): use the shared dir if it passes the ownership
 * check, else the private fallback only if IT passes, else persist nothing.
 * A directory that fails the check is never written to, whichever one it is.
 *
 * TMPDIR, HOME and PLUR_PATH point into a temp dir; never the real ~/.plur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hookSessionDir, writeSessionTask, readSessionTask, removeSessionTask } from '../src/lib/session-task.js'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const ENV_KEYS = ['TMPDIR', 'HOME', 'PLUR_PATH'] as const

describe.skipIf(process.platform === 'win32')('hook state dir: refuse, never redirect', () => {
  let root: string
  let saved: Record<string, string | undefined>
  let evilShared: string
  let evilFallback: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-dir-refusal-'))
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const d of ['tmp', 'home', 'store', 'evil-shared', 'evil-fallback']) mkdirSync(join(root, d))
    process.env.TMPDIR = join(root, 'tmp')
    process.env.HOME = join(root, 'home')
    process.env.PLUR_PATH = join(root, 'store')
    evilShared = join(root, 'evil-shared')
    evilFallback = join(root, 'evil-fallback')
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(root, { recursive: true, force: true })
  })

  function plantBoth(): void {
    symlinkSync(evilShared, join(root, 'tmp', 'plur-sessions'))
    symlinkSync(evilFallback, join(root, 'store', 'hook-sessions'))
  }

  it('uses the private fallback when only the shared dir is planted', () => {
    symlinkSync(evilShared, join(root, 'tmp', 'plur-sessions'))
    expect(hookSessionDir()).toBe(join(root, 'store', 'hook-sessions'))
    writeSessionTask('s1', 'first prompt')
    expect(readSessionTask('s1')).toBe('first prompt')
    expect(readdirSync(evilShared)).toEqual([])
  })

  it('returns null when the shared dir and the fallback are both refused', () => {
    plantBoth()
    expect(hookSessionDir()).toBeNull()
  })

  it('never writes the session task into a refused fallback dir (formal replay)', () => {
    plantBoth()
    writeSessionTask('s2', 'secret prompt text')
    expect(readSessionTask('s2')).toBe('')
    removeSessionTask('s2')
    expect(readdirSync(evilShared)).toEqual([])
    expect(readdirSync(evilFallback)).toEqual([])
  })

  it('hook-inject with both dirs refused: exits 0, still injects, persists nothing', () => {
    plantBoth()
    const cwd = join(root, 'home')
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    const env = { ...process.env, USERPROFILE: cwd, PLUR_DISABLE_EMBEDDINGS: '1' }
    for (const args of [[], ['--rehydrate'], ['--event', 'skill']]) {
      const r = runCli('node', [CLI, 'hook-inject', ...args], {
        input: JSON.stringify({ session_id: 'sess-both-planted', prompt: 'secret prompt text', tool_input: { skill: 'x' } }),
        encoding: 'utf-8', timeout: 20_000, env, cwd,
      })
      expect(r.status).toBe(0)
      expect(r.stdout ?? '').not.toContain('"error"')
    }
    // The first-message path still delivers its session header.
    const first = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ session_id: 'sess-both-planted', prompt: 'secret prompt text' }),
      encoding: 'utf-8', timeout: 20_000, env, cwd,
    })
    expect(first.stdout).toContain('session started')
    expect(readdirSync(evilShared)).toEqual([])
    expect(readdirSync(evilFallback)).toEqual([])
  }, 60_000)
})
