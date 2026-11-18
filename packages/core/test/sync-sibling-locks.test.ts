/**
 * Security audit 2026-11-06: git sync rewrites episodes.yaml, tensions.yaml
 * and candidates.yaml on the pull path (holdWithheld reads the file, runs
 * `git checkout -- <file>`, pulls, then restoreWithheld writes the saved copy
 * back), but Plur.sync held only the engram store lock. The ordinary writers
 * of those files (captureEpisode, the tension writers) lock only
 * `<file>.lock`, so a capture that landed between the read and the checkout
 * was reported as saved and then silently overwritten.
 *
 * This test injects a second writer at the exact `git checkout --
 * episodes.yaml` point. A writer that can take the episodes lock there writes
 * straight away (and, before the fix, is lost). A writer that finds the lock
 * held waits until sync is done, as the real busy-waiting writer would.
 * Either way, an episode reported as saved must survive the sync.
 *
 * Local bare git remote only — no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'

const hook: { fn: ((args: readonly string[]) => void) | null } = { fn: null }
vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('child_process')>()
  return {
    ...orig,
    execFileSync: ((file: string, args?: readonly string[], opts?: unknown) => {
      if (file === 'git' && Array.isArray(args) && hook.fn) hook.fn(args)
      return (orig.execFileSync as any)(file, args, opts)
    }) as typeof orig.execFileSync,
  }
})

const { execFileSync } = await import('child_process')
const { Plur } = await import('../src/index.js')
const { withLock } = await import('../src/sync.js')
const { isolateGitConfig } = await import('./helpers/git-isolation.js')

function git(args: string[], cwd: string): string {
  return (execFileSync('git', args, { cwd, encoding: 'utf8' }) as string).trim()
}

/** Can a writer take `<file>.lock` right now without waiting? */
function lockFree(path: string): boolean {
  try {
    withLock(path, () => {}, { maxRetries: 0 })
    return true
  } catch {
    return false
  }
}

describe('git sync holds the sibling store locks (security audit 2026-11-06)', () => {
  isolateGitConfig({ defaultBranch: 'main' })
  let root: string, dir: string, bare: string, clone: string
  let prevHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-sync-sibling-locks-'))
    prevHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    dir = join(root, 'store')
    bare = join(root, 'remote.git')
    clone = join(root, 'clone')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    git(['init', '--bare', '-b', 'main', bare], root)
  })
  afterEach(() => {
    hook.fn = null
    process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  it('an episode captured at the checkout of episodes.yaml survives the sync', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('dummy global fact alpha', { scope: 'global', type: 'behavioral' })
    const local = await plur.learn('dummy local fact beta', { scope: 'local', type: 'behavioral' })
    // An episode naming the scope:local engram, so the pull path holds it back.
    plur.capture(`session about ${local.id}`)
    await plur.sync(bare)
    // Advance the remote by one commit from another clone, so the next sync pulls.
    git(['clone', bare, clone], root)
    writeFileSync(join(clone, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    const remotePlur = new Plur({ path: clone })
    await remotePlur.learn('dummy remote fact gamma', { scope: 'global', type: 'behavioral' })
    remotePlur.close()
    git(['add', 'engrams.yaml'], clone)
    git(['commit', '-m', 'dummy remote commit'], clone)
    git(['push', 'origin', 'HEAD'], clone)

    const other = new Plur({ path: dir })
    let injected = false
    let deferred = false
    const locksAtCheckout: Record<string, boolean> = {}
    hook.fn = (args) => {
      if (injected || args[0] !== 'checkout' || !args.includes('episodes.yaml')) return
      injected = true
      for (const f of ['episodes.yaml', 'tensions.yaml', 'candidates.yaml']) {
        locksAtCheckout[f] = !lockFree(join(dir, f))
      }
      if (locksAtCheckout['episodes.yaml']) deferred = true
      else other.capture('CONCURRENT dummy capture during sync')
    }
    const res = await plur.sync(bare)
    hook.fn = null
    expect(injected, 'the pull path never reset episodes.yaml — fixture did not exercise it').toBe(true)
    expect(res.message).toMatch(/pulled 1 remote commit/)
    // A writer that found the lock held waits it out, then writes.
    if (deferred) other.capture('CONCURRENT dummy capture during sync')

    const onDisk = readFileSync(join(dir, 'episodes.yaml'), 'utf8')
    expect(onDisk, 'a capture reported as saved was discarded by sync').toContain('CONCURRENT dummy capture during sync')
    expect(onDisk).toContain(`session about ${local.id}`)
    expect(locksAtCheckout).toEqual({ 'episodes.yaml': true, 'tensions.yaml': true, 'candidates.yaml': true })
  })
})
