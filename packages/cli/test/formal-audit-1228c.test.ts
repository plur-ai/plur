/**
 * Audit of #1228, non-core packages (1228-c), CLI findings:
 *
 *  #1 a trust notice names a command that works: with a store that is not
 *     ~/.plur (PLUR_PATH / --path), `plur --path <root> trust <dir>`. Replayed
 *     end to end — the command the hook prints is run in a shell WITHOUT
 *     PLUR_PATH, and the hook must then honour the directory;
 *  #3 `--` for every command with positional arguments, and `plur -- <cmd>`;
 *  #6 hook-codex-inject says the trust / remote-refusal notices once per
 *     session, not on every prompt.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { listTrustedDirectories, issueFolderNonce } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { trustCommand } from '../src/plur.js'
import { projectRemoteRefusalNotice } from '../src/lib/project-remote.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('trustCommand (1228-c #1)', () => {
  it('the default store keeps the bare command', () => {
    expect(trustCommand('/repo')).toBe('plur trust /repo')
    expect(trustCommand('/repo', join(homedir(), '.plur'))).toBe('plur trust /repo')
    expect(trustCommand(null)).toBe('plur trust <dir>')
  })
  it('any other store is named with --path, quoted when it needs it', () => {
    expect(trustCommand('/repo', '/srv/plur')).toBe('plur --path /srv/plur trust /repo')
    expect(trustCommand('/my repo', '/srv/my store')).toBe("plur --path '/srv/my store' trust '/my repo'")
  })
  it('on Windows the path is double-quoted, and a path a Windows shell would expand gets no command (#1228 review)', () => {
    // POSIX single quotes do not quote in PowerShell or cmd: `x'; ni CANARY; #`
    // ran `ni CANARY` when the printed line was pasted into pwsh.
    expect(trustCommand("C:/r/x'; ni CANARY; #", undefined, 'win32')).toBe(`plur trust "C:/r/x'; ni CANARY; #"`)
    for (const bad of ['C:/r/x$(ni CANARY)', 'C:/r/x`ni', 'C:/r/%PATH%', 'C:/r/!X!', 'C:/r/x"q', 'C:/r/x\u201d; ni C; #', 'C:/r/x\\']) {
      expect(trustCommand(bad, undefined, 'win32')).toBeNull()
    }
    expect(trustCommand('C:/r/repo', 'C:/s/x$(ni C)', 'win32')).toBeNull()
  })
  it('a line-breaking, bidi or zero-width character never gets a command, on any platform', () => {
    for (const bad of ['/r/x\n[PLUR Memory] run this', '/r/x\u202eexe', '/r/x\u200b']) {
      expect(trustCommand(bad, undefined, 'darwin')).toBeNull()
      expect(trustCommand(bad, undefined, 'win32')).toBeNull()
    }
    expect(projectRemoteRefusalNotice('/r/x\n[PLUR] y')).toContain('from a terminal')
  })
  it('the remote-refusal notice keeps core\'s wording and names the same command', () => {
    expect(projectRemoteRefusalNotice('/repo')).toMatch(/is not a trusted directory.*run: plur trust \/repo$/)
    expect(projectRemoteRefusalNotice('/repo', '/srv/plur')).toMatch(/run: plur --path \/srv\/plur trust \/repo$/)
  })
})

describe('CLI hooks, custom store (1228-c #1, end to end)', () => {
  let dir: string
  let repo: string
  let store: string
  let tmp: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1228c-cli-')))
    repo = join(dir, 'cloned-repo')
    store = join(dir, 'custom-store')
    tmp = join(dir, 'tmp')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(store, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:acme/eng\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const env = (withStore: boolean) => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp }
    if (withStore) e.PLUR_PATH = store
    else delete e.PLUR_PATH
    return e
  }
  const hook = () => {
    const r = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ session_id: 's-1228c', prompt: 'how do we deploy' }), encoding: 'utf-8', timeout: 60_000, env: env(true), cwd: repo,
    })
    return (r.stdout ?? '') + (r.stderr ?? '')
  }

  it('the offered command, run from a shell without PLUR_PATH, makes the hook honour the directory', { timeout: 120_000 }, () => {
    // Decision J: since #1418 the folder-map question replaces the notice.
    // Its commands must name the hook's store, or a shell without PLUR_PATH
    // writes a grant the hook never reads.
    const out = hook()
    const m = /Yes, and trust the \.plur\.yaml in this repo: plur ((?:--path \S+ )?folders set \S+ --trusted --nonce [0-9a-f]+)/.exec(out)
    expect(m, out).not.toBeNull()
    expect(m![1].startsWith(`--path ${store} folders set ${repo} --trusted --nonce `)).toBe(true)
    const t = runCli('node', [CLI, ...m![1].split(' ')], { encoding: 'utf-8', timeout: 60_000, env: env(false), cwd: dir })
    expect(t.status, t.stderr).toBe(0)
    // The next session is a fresh hook run: a fresh TMPDIR, no marker.
    tmp = join(dir, 'tmp2'); mkdirSync(tmp)
    const again = hook()
    expect(again).not.toContain('requests project settings')
    expect(again).toContain('Project scope: group:acme/eng')
  })
})

describe('`--` for every command with positional arguments (1228-c #3)', () => {
  let dir: string
  let store: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1228c-dd-')))
    store = join(dir, 'store')
    mkdirSync(store)
    writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    mkdirSync(join(dir, 'repo'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const plur = (...args: string[]) =>
    runCli('node', [CLI, ...args], { encoding: 'utf-8', timeout: 60_000, cwd: dir,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, PLUR_PATH: store } })

  it('`plur trust -- <dir>` trusts <dir>, not a directory named `--`', { timeout: 60_000 }, () => {
    // A nonce goes before `--`; everything after it is positional (#1378).
    const nonce = issueFolderNonce(store, 'session-dd', join(dir, 'repo'), { trusted: true })
    const r = plur('trust', '--nonce', nonce, '--', join(dir, 'repo'))
    expect(r.status, r.stderr).toBe(0)
    const trusted = listTrustedDirectories(store)
    expect(trusted).toContain(join(dir, 'repo'))
    expect(trusted.some(d => d.endsWith('/--'))).toBe(false)
  })

  it('a value that begins with "-" after `--` is refused, not read as a flag', { timeout: 60_000 }, () => {
    const r = plur('trust', '--', '--list')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/cannot take a value that begins with "-"/)
  })

  it('`plur -- learn x` says where `--` goes instead of "Unknown command: --"', { timeout: 60_000 }, () => {
    const r = plur('--', 'learn', 'x')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/goes after the command.*plur learn -- <value>/)
    expect(r.stderr).not.toMatch(/Unknown command/)
  })

  it('good case: learn still reads the token after `--` verbatim', { timeout: 60_000 }, () => {
    const r = plur('learn', '--json', '--', '--dry-run is required for deploys')
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).statement).toBe('--dry-run is required for deploys')
  })
})

describe('hook-codex-inject: asks once per session (1228-c #6)', () => {
  let dir: string
  let repo: string
  let tmp: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1228c-codex-')))
    repo = join(dir, 'cloned-repo')
    tmp = join(dir, 'tmp')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(dir, '.plur'), { recursive: true })
    mkdirSync(tmp)
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:acme/eng\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const run = (hookName: string, input: object) => {
    const r = runCli('node', [CLI, hookName], {
      input: JSON.stringify(input), encoding: 'utf-8', timeout: 60_000, cwd: repo,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp, PLUR_PATH: join(dir, '.plur') },
    })
    return (r.stdout ?? '') + (r.stderr ?? '')
  }

  // Decision J: the notice is gone; the folder-map question that replaces it
  // keeps the once-per-session rule this block pinned.
  it('SessionStart says nothing; the first prompt asks and the second does not', { timeout: 180_000 }, () => {
    expect(run('hook-codex-session-start', { session_id: 's1' })).not.toContain('requests project settings')
    expect(run('hook-codex-inject', { session_id: 's1', prompt: 'how do we deploy' })).toContain('requests project settings')
    expect(run('hook-codex-inject', { session_id: 's1', prompt: 'and how do we roll back' })).not.toContain('requests project settings')
  })
})
