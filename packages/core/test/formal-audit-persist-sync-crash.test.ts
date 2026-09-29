/**
 * Audit of #1228 (persistence slice), finding 1 (HIGH, data loss).
 *
 * To let `git pull` run while scope:local engrams exist, sync resets
 * engrams.yaml to the committed (stripped) blob and puts the withheld records
 * back afterwards. They used to live ONLY in the sync process's memory in
 * between, and `git pull` is a blocking call of up to 30 s: a Ctrl-C, SIGTERM
 * or SIGKILL during it left a clean tree and every scope:local engram gone.
 * Unlocked readers (hooks, MCP recall, the index sync) also saw a store with no
 * local engrams for the length of the pull.
 *
 * Now the held records are written durably to `.git/plur-held.json` before the
 * tree is touched and deleted only after they are back; every reader counts
 * them as part of the store; the next write or sync restores them.
 *
 * Also the restore case the audit left unconfirmed: a pulled engrams.yaml the
 * loader refuses used to be overwritten with the PRE-pull bytes while HEAD held
 * the remote version, so the next commit pushed a silent revert. Now the pull's
 * result is kept, the held records stay in the recovery file, and sync says so.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { execFileSync, spawn } from 'child_process'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { loadEngrams, saveEngrams, heldRecoveryPath } from '../src/engrams.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

const SYNC_SRC = resolve(__dirname, '../src/sync.ts')

const eng = (id: string, statement: string, scope = 'global') =>
  ({ id, statement, type: 'behavioral', status: 'active', confidence: 0.5, created: '2026-09-27', scope })
// Fixtures are written in PLUR's own serialisation (load + save), so a later
// PLUR write does not re-format pushed records and conflict with the remote.
const write = (root: string, list: unknown[]) => {
  mkdirSync(root, { recursive: true })
  const file = join(root, 'engrams.yaml')
  writeFileSync(file, yaml.dump({ engrams: list }, { lineWidth: 120, noRefs: true }))
  saveEngrams(file, loadEngrams(file), { allowShrink: true })
}
const readRaw = (root: string) => (yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as any).engrams as any[]
const locals = (list: Array<{ scope?: string }>) => list.filter(e => e.scope === 'local')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('audit #1228 finding 1: an interrupted sync loses no scope:local engram', { timeout: 120_000 }, () => {
  isolateGitConfig({ defaultBranch: 'main' }) // the fixture names `main`
  let base: string, bare: string, A: string, B: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-audit-crash-'))
    bare = join(base, 'remote.git')
    A = join(base, 'A')
    B = join(base, 'B')
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
    write(A, [eng('ENG-2026-09-27-001', 'shared one')])
    sync(A, bare)
    execFileSync('git', ['clone', '-q', bare, B])
    write(A, [...readRaw(A), ...Array.from({ length: 5 }, (_, i) => eng(`ENG-2026-09-27-10${i}`, `A local only ${i}`, 'local'))])
    sync(A)
    write(B, [...readRaw(B), eng('ENG-2026-09-27-003', 'B other')])
    sync(B)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  /** Start `sync(A)` in a child whose `git pull` blocks, and return once the pull is running. */
  async function startBlockedSync() {
    const cnt = join(base, 'cnt')
    const up = join(base, 'slow-upload-pack.sh')
    // 1st upload-pack = sync's `git fetch`; 2nd = the pull, which blocks.
    writeFileSync(up, `#!/bin/sh\nn=$(cat "${cnt}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${cnt}"\nif [ $n -ge 2 ]; then sleep 60; fi\nexec git-upload-pack "$@"\n`, { mode: 0o755 })
    git(A, 'config', 'remote.origin.uploadpack', up)
    const script = join(base, 'child.mts')
    writeFileSync(script, `const { sync } = await import(${JSON.stringify(SYNC_SRC)}); sync(${JSON.stringify(A)})\n`)
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: resolve(__dirname, '..'), stdio: 'ignore', detached: true, env: process.env,
    })
    const exited = new Promise<void>(r => child.on('exit', () => r()))
    for (let i = 0; i < 300; i++) {
      if (existsSync(cnt) && Number(readFileSync(cnt, 'utf8').trim()) >= 2) break
      await sleep(100)
    }
    expect(Number(readFileSync(cnt, 'utf8').trim())).toBeGreaterThanOrEqual(2)
    await sleep(300)
    return { child, exited }
  }

  function unblock() {
    git(A, 'config', '--unset', 'remote.origin.uploadpack')
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    it(`${signal} mid-pull: the store still holds all 5 local engrams, and the next sync restores them`, async () => {
      const { child, exited } = await startBlockedSync()
      // Mid-pull the tree is reset; the held records are on disk, and a reader sees them.
      expect(existsSync(heldRecoveryPath(A))).toBe(true)
      expect(locals(loadEngrams(join(A, 'engrams.yaml')))).toHaveLength(5)

      process.kill(-child.pid!, signal)
      await exited

      // Store open after the crash: nothing lost.
      expect(locals(loadEngrams(join(A, 'engrams.yaml')))).toHaveLength(5)

      unblock()
      const res = sync(A)
      expect(res.action).toBe('synced')
      const after = readRaw(A)
      expect(locals(after)).toHaveLength(5)
      expect(after.map(e => e.id).sort()).toEqual([
        'ENG-2026-09-27-001', 'ENG-2026-09-27-003',
        ...Array.from({ length: 5 }, (_, i) => `ENG-2026-09-27-10${i}`),
      ].sort())
      expect(existsSync(heldRecoveryPath(A))).toBe(false)
      // Nothing withheld reached the remote.
      const C = join(base, 'C')
      execFileSync('git', ['clone', '-q', bare, C])
      expect(locals(readRaw(C))).toHaveLength(0)
      expect(git(A, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0')
    })
  }

  it('SIGKILL mid-pull, then a write before any sync: the write persists the held records once, and the next sync does not duplicate them', async () => {
    const { child, exited } = await startBlockedSync()
    process.kill(-child.pid!, 'SIGKILL')
    await exited
    unblock()

    const store = join(A, 'engrams.yaml')
    const loaded = loadEngrams(store)
    // A writer changes a held engram (e.g. feedback) and saves.
    const edited = loaded.map(e => e.id === 'ENG-2026-09-27-100' ? { ...e, statement: 'A local only 0 (edited)' } : e)
    saveEngrams(store, edited)
    expect(locals(readRaw(A))).toHaveLength(5)
    expect(existsSync(heldRecoveryPath(A))).toBe(false)

    sync(A)
    const after = readRaw(A)
    expect(locals(after)).toHaveLength(5)
    expect(after.map(e => e.id)).toContain('ENG-2026-09-27-003')
    expect(git(A, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0')
    expect(after.filter(e => e.id.startsWith('ENG-2026-09-27-100'))).toHaveLength(1)
    expect(after.find(e => e.id === 'ENG-2026-09-27-100').statement).toBe('A local only 0 (edited)')
  })

  it('a pulled engrams.yaml the loader refuses is kept as pulled (no revert pushed); the held records wait in the recovery file and come back once it is fixed', () => {
    // B (an older client, or a hand edit) pushes a bare-array engrams.yaml.
    const bad = yaml.dump([eng('ENG-2026-09-27-001', 'shared one'), eng('ENG-2026-09-27-003', 'B other'), eng('ENG-2026-09-27-004', 'B bare')])
    writeFileSync(join(B, 'engrams.yaml'), bad)
    git(B, 'commit', '-qam', 'bare array')
    git(B, 'push', '-q', 'origin', 'HEAD')

    const res = sync(A)
    // The pull's result is kept: the working tree matches HEAD, so no revert is pending.
    expect(readFileSync(join(A, 'engrams.yaml'), 'utf8')).toBe(bad)
    expect(git(A, 'status', '--porcelain', '--', 'engrams.yaml')).toBe('')
    expect(git(A, 'rev-list', '--count', 'HEAD..origin/main')).toBe('0')
    // Sync says what happened.
    expect(`${res.message} ${res.warning ?? ''}`).toMatch(/engrams\.yaml/)
    expect(`${res.message} ${res.warning ?? ''}`).toMatch(/plur-held\.json/)
    // The 5 local engrams are held durably.
    const held = JSON.parse(readFileSync(heldRecoveryPath(A), 'utf8'))
    expect(locals(held.files.find((f: any) => f.file === 'engrams.yaml').held)).toHaveLength(5)

    // The user fixes the file (the loader's message says how) and syncs again.
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump({ engrams: yaml.load(bad) }))
    sync(A)
    const after = readRaw(A)
    expect(locals(after)).toHaveLength(5)
    expect(after.map(e => e.id)).toContain('ENG-2026-09-27-004')
    expect(existsSync(heldRecoveryPath(A))).toBe(false)
    const C = join(base, 'C')
    execFileSync('git', ['clone', '-q', bare, C])
    expect(locals(readRaw(C))).toHaveLength(0)
    expect(readRaw(C).map(e => e.id)).toContain('ENG-2026-09-27-004')
  })
})
