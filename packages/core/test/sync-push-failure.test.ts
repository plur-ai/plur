/**
 * A failed `git push` must reach the caller.
 *
 * `syncEngrams` pushed via `gitSafe(['push','origin'], root)`. `gitSafe`
 * catches and returns null, and the return value was discarded — so a rejected
 * push (expired credentials, no network, non-fast-forward) produced a result
 * byte-identical to a successful one: `action: 'synced'`, no warning, nothing.
 *
 * That is the worst shape for an agent caller. It reports the sync worked, and
 * the engrams sit on the local machine indefinitely with nobody looking — which
 * is precisely the failure `plur sync` exists to prevent.
 *
 * Set up with a real git repo whose `origin` points at a path that is not a
 * repository, so the push fails the way a broken remote does, without needing
 * a network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { sync as syncEngrams } from '../src/sync.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

/**
 * Run git against the fixture repo, insulated from the developer's own config.
 *
 * `core.excludesFile=/dev/null` is not decoration. A global gitignore that lists
 * `engrams.yaml` — a sensible thing for anyone working on a memory engine to
 * have, so their own store can never be committed by accident — silently made
 * `git add -A` stage nothing here, and the seed commit then failed with
 * "nothing to commit". The whole suite failed on that machine and passed in
 * continuous integration, which is the worst shape a test failure can take.
 *
 * The fixture is a throwaway repo testing sync behaviour. Whose machine it runs
 * on must not change the answer.
 */
const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe('syncEngrams reports a failed push', () => {
  isolateGitConfig() // a global gitignore of engrams.yaml empties the seed commit (#1062)
  let root: string
  let remote: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-syncfail-'))
    remote = mkdtempSync(join(tmpdir(), 'plur-syncfail-remote-'))
    git(['init', '--quiet'], root)
    git(['config', 'user.email', 'test@example.invalid'], root)
    git(['config', 'user.name', 'Test'], root)
    writeFileSync(join(root, 'engrams.yaml'), 'engrams: []\n')
    git(['add', '-A'], root)
    git(['commit', '--quiet', '-m', 'seed'], root)
  })

  afterEach(() => {
    for (const d of [root, remote]) if (d) rmSync(d, { recursive: true, force: true })
  })

  it('surfaces push_error when the remote rejects', () => {
    // Upstream tracking must exist first: `countDiff` uses `HEAD...@{u}`, so
    // without a tracking branch it reports 0 ahead and the push never runs —
    // which is why the first version of this test saw no error to report.
    // So: publish to a real bare remote, then destroy it. That is also the
    // realistic shape — the remote worked when it was configured and has since
    // become unreachable.
    const bare = join(remote, 'gone.git')
    git(['init', '--bare', '--quiet', bare], remote)
    git(['remote', 'add', 'origin', bare], root)
    git(['push', '--quiet', '-u', 'origin', 'HEAD'], root)
    rmSync(bare, { recursive: true, force: true })

    writeFileSync(join(root, 'engrams.yaml'), 'engrams: [{id: E-1}]\n')

    const res = syncEngrams(root)

    expect(res.push_error, 'the push failed and the caller was not told').toBeTruthy()
    expect(String(res.message)).toMatch(/NOT pushed/)
  })

  it('a SUCCESSFUL sync carries no push_error — the signal has to mean something', () => {
    // Guards against "always report an error", which would be as useless as
    // never reporting one.
    const bare = join(remote, 'bare.git')
    git(['init', '--bare', '--quiet', bare], remote)
    git(['remote', 'add', 'origin', bare], root)
    git(['push', '--quiet', '-u', 'origin', 'HEAD'], root)
    writeFileSync(join(root, 'engrams.yaml'), 'engrams: [{id: E-2}]\n')

    const res = syncEngrams(root)

    expect(res.push_error).toBeUndefined()
    expect(String(res.message)).not.toMatch(/NOT pushed/)
  })

  it('the commit still happens — a failed push is not a failed commit', () => {
    // The local commit genuinely occurred, so downgrading the whole call to an
    // error would be wrong and would break offline use.
    const bare3 = join(remote, 'gone3.git')
    git(['init', '--bare', '--quiet', bare3], remote)
    git(['remote', 'add', 'origin', bare3], root)
    git(['push', '--quiet', '-u', 'origin', 'HEAD'], root)
    rmSync(bare3, { recursive: true, force: true })
    writeFileSync(join(root, 'engrams.yaml'), 'engrams: [{id: E-3}]\n')

    const res = syncEngrams(root)

    expect(res.action).toBe('synced')
    expect(res.files_changed).toBeGreaterThan(0)
    // And the commit is really in the log.
    expect(git(['log', '--oneline'], root).trim().split('\n').length).toBeGreaterThan(1)
  })
})
