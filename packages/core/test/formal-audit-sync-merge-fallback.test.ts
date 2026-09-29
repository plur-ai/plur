/**
 * Audit follow-up (2026-09-27, pre-existing): when `git pull --rebase` fails,
 * sync falls back to a merge with `git pull origin <branch> --no-edit`. Git
 * 2.27+ refuses that for divergent branches unless a reconcile mode is set
 * ("Need to specify how to reconcile divergent branches"), so sync reported
 * "NOT pulled" in exactly the case the fallback exists for. The fallback now
 * says `--no-rebase` explicitly.
 *
 * Case: machine A has two local commits that change and then restore one line
 * of episodes.yaml; the remote changed that line. Rebase replays A's first
 * commit and conflicts; a merge sees no net local change and takes the remote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { sync as syncEngrams } from '../src/sync.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

isolateGitConfig()

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-merge-fallback-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const EP = (line: string) => `episodes:\n  - id: EP-1\n    summary: "${line}"\n  - id: EP-2\n    summary: "stable"\n`
const ENGRAMS = 'engrams: []\n'

describe('sync merge fallback on divergent branches', () => {
  it('pulls the remote change when the rebase conflicts but a merge is clean', { timeout: 60_000 }, () => {
    const remote = join(dir, 'remote.git')
    git(['init', '--bare', '-q', '-b', 'main', remote], dir)

    // Seed from B.
    const b = join(dir, 'b')
    git(['clone', '-q', remote, b], dir)
    writeFileSync(join(b, 'engrams.yaml'), ENGRAMS)
    writeFileSync(join(b, 'episodes.yaml'), EP('original'))
    git(['add', '-A'], b); git(['commit', '-qm', 'seed'], b); git(['push', '-q', 'origin', 'HEAD:main'], b)

    // A clones, then makes two commits that cancel out on EP-1.
    const a = join(dir, 'a')
    git(['clone', '-q', remote, a], dir)
    writeFileSync(join(a, 'episodes.yaml'), EP('from A'))
    git(['commit', '-qam', 'a1'], a)
    writeFileSync(join(a, 'episodes.yaml'), EP('original'))
    git(['commit', '-qam', 'a2'], a)

    // B changes EP-1 and pushes.
    writeFileSync(join(b, 'episodes.yaml'), EP('from B'))
    git(['commit', '-qam', 'b1'], b); git(['push', '-q', 'origin', 'HEAD:main'], b)

    const r = syncEngrams(a, remote)
    expect(r.message).not.toMatch(/NOT pulled/)
    expect(readFileSync(join(a, 'episodes.yaml'), 'utf8')).toContain('from B')
    expect(git(['rev-list', '--count', 'HEAD..origin/main'], a).trim()).toBe('0')
  })
})
