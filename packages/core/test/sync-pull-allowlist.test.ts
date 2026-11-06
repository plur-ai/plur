/**
 * Security audit 2026-11-06: `plur sync` pushes only the store allowlist, but a
 * plain `git pull` checked out every path the remote carried and silently
 * overwrote IGNORED files (config.yaml, keys/). A teammate with push rights on
 * a shared sync remote could replace the victim's config.yaml (flipping
 * sync.remote_type to personal) or plant a trust.yaml grant. A pull must now
 * refuse any incoming path outside the engram store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { sync as syncEngrams } from '../src/sync.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

isolateGitConfig()

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const ENGRAMS = 'engrams: []\n'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pull-allow-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  const remote = join(dir, 'remote.git')
  git(['init', '--bare', '-q', '-b', 'main', remote], dir)
  const victim = join(dir, 'victim')
  mkdirSync(victim)
  writeFileSync(join(victim, 'engrams.yaml'), ENGRAMS)
  writeFileSync(join(victim, 'config.yaml'), 'sync:\n  remote_type: shared\n')
  syncEngrams(victim, remote) // first sync: init, add origin, push
  const mate = join(dir, 'mate')
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], victim).trim()
  git(['clone', '-q', '-b', branch, remote, mate], dir)
  return { remote, victim, mate }
}

function trySync(root: string): string {
  try { return syncEngrams(root).message } catch (err) { return `THREW: ${(err as Error).message}` }
}

describe('sync pull refuses paths outside the engram store', () => {
  it('a pushed config.yaml / trust.yaml / keys file never lands locally', { timeout: 60_000 }, () => {
    const { victim, mate } = setup()
    writeFileSync(join(mate, 'config.yaml'), 'sync:\n  remote_type: personal\n')
    writeFileSync(join(mate, 'trust.yaml'), 'trusted:\n  - /\n')
    mkdirSync(join(mate, 'keys'))
    writeFileSync(join(mate, 'keys', 'x.key'), 'TEAMMATE-KEY')
    git(['add', '-f', 'config.yaml', 'trust.yaml', 'keys/x.key'], mate)
    git(['commit', '-qm', 'plant'], mate); git(['push', '-q', 'origin', 'HEAD'], mate)

    const msg = trySync(victim)
    expect(msg).toMatch(/refusing to pull/)
    expect(readFileSync(join(victim, 'config.yaml'), 'utf8')).toContain('remote_type: shared')
    expect(existsSync(join(victim, 'trust.yaml'))).toBe(false)
    expect(existsSync(join(victim, 'keys', 'x.key'))).toBe(false)
  })

  it('an ordinary store change from a teammate still pulls', { timeout: 60_000 }, () => {
    const { victim, mate } = setup()
    writeFileSync(join(mate, 'engrams.yaml'), 'engrams: []\n# teammate edit\n')
    git(['commit', '-qam', 'store edit'], mate); git(['push', '-q', 'origin', 'HEAD'], mate)
    const msg = trySync(victim)
    expect(msg).not.toMatch(/refusing to pull|THREW/)
    expect(git(['rev-list', '--count', 'HEAD..@{u}'], victim).trim()).toBe('0')
  })
})
