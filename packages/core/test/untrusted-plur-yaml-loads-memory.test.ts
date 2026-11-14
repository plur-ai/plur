/**
 * Decision D1, revised (owner, 2026-11-14: "load memories but ignore untrusted
 * settings"). A repo `.plur.yaml` that requests settings (scope, domain,
 * remote) and that no folder-map entry trusts no longer blocks memory: the
 * folder is `on` exactly as if the file requested nothing — none of its
 * settings apply — and the policy keeps `reason: 'untrusted-plur-yaml'` and
 * `requested` so the hooks can still offer the one-time trust question.
 *
 * Everything stricter keeps winning: a map `off`, `remote-only`, an `ask` the
 * user set, a folder map that cannot be read (fail safe). Trust stays the only
 * way the file's scope, domain or remote apply.
 *
 * Every test builds its own home and PLUR root under a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  resolveFolderPolicy, saveFolderMap, setFolderEntry, issueFolderNonce, loadFolderMap, folderMapPath,
  type FolderEntry,
} from '../src/folders.js'
import { sessionSettings, folderAsk } from '../src/folder-ask.js'
import type { GitScopeSource, OriginRead } from '../src/git-origin.js'

let base: string
let home: string
let root: string
let repo: string

const policy = (dir: string = repo) => resolveFolderPolicy(dir, { root, home })
const writeMap = (folders: FolderEntry[]) => saveFolderMap(root, { version: 1, folders })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-untrusted-yaml-')))
  home = join(base, 'home')
  root = join(home, '.plur')
  mkdirSync(root, { recursive: true })
  repo = join(home, 'src', 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.plur.yaml'),
    'scope: project:hint\ndomain: x.y\nremote_url: http://127.0.0.1:9\nremote_token: secret-token\n')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('an untrusted .plur.yaml that requests settings', () => {
  it('is on, with no scope from it, no remote, and the reason and requests kept for the question', () => {
    const p = policy()
    expect(p).toEqual({
      mode: 'on', remoteAllowed: false, source: 'plur-yaml', reason: 'untrusted-plur-yaml',
      requested: { scope: 'project:hint', domain: 'x.y', remote_url: 'http://127.0.0.1:9' },
    })
    expect(p.scope).toBeUndefined()
    expect(JSON.stringify(p)).not.toContain('secret-token')
  })

  it('applies to a subfolder of the repository too', () => {
    const sub = join(repo, 'pkg')
    mkdirSync(sub)
    expect(policy(sub)).toMatchObject({ mode: 'on', remoteAllowed: false, reason: 'untrusted-plur-yaml' })
    expect(policy(sub).scope).toBeUndefined()
  })

  it('gets no domain in the session settings: its domain applies only when trusted', () => {
    expect(sessionSettings(policy(), { domain: 'x.y' })).toEqual({})
  })

  it('is not given a git-origin default scope either (the reason blocks it)', () => {
    const scope = 'project:acme/team/backend'
    const source: GitScopeSource = { server: 'https://plur.example.com', gitlab_host: 'gitlab.example.com', status: 'ok',
      scopes: [scope], project_paths: { [scope]: 'team/backend' }, discovered_at: new Date().toISOString() }
    const read = vi.fn((): OriginRead => ({ kind: 'url', url: 'git@gitlab.example.com:team/backend.git' }))
    const p = resolveFolderPolicy(repo, { root, home, gitScopes: [source], readOrigin: read })
    expect(read).not.toHaveBeenCalled()
    expect(p.scope).toBeUndefined()
    expect(p).toMatchObject({ mode: 'on', reason: 'untrusted-plur-yaml' })
  })

  it('still lets the trust question be answered: the --trusted nonce is redeemable and then the hint applies', () => {
    const n = issueFolderNonce(root, 'sess-trust', repo, { trusted: true }, Date.now(), { home })
    setFolderEntry(root, repo, { trusted: true }, { configuredScopes: [], nonce: n, home })
    expect(loadFolderMap(root).folders).toEqual([{ path: repo, trusted: true }])
    expect(policy()).toEqual({ mode: 'on', scope: 'project:hint', remoteAllowed: true, source: 'plur-yaml' })
  })

  it('still lets "Yes, without its settings" and "Never here" be answered', () => {
    const on = issueFolderNonce(root, 'sess-on', repo, { mode: 'on' }, Date.now(), { home })
    setFolderEntry(root, repo, { mode: 'on' }, { configuredScopes: [], nonce: on, home })
    expect(policy()).toEqual({ mode: 'on', remoteAllowed: false, source: 'map' })
    writeMap([])
    const off = issueFolderNonce(root, 'sess-off', repo, { mode: 'off' }, Date.now(), { home })
    setFolderEntry(root, repo, { mode: 'off' }, { configuredScopes: [], nonce: off, home })
    expect(policy().mode).toBe('off')
  })

  it('offers the trust question with wording that says memories were loaded and its settings are ignored', () => {
    const ask = folderAsk({ dir: repo, policy: policy(), sessionId: 'sess-q', root, claim: () => true })
    expect(ask).not.toBeNull()
    expect(ask!.text).toContain('the repo .plur.yaml is not trusted')
    expect(ask!.text).toContain('memories were loaded')
    expect(ask!.text).toContain('settings are ignored')
    expect(ask!.text).not.toContain('no memories were loaded')
    expect(ask!.text).toContain(`plur folders set ${repo} --trusted --nonce `)
    expect(ask!.text).not.toContain('secret-token')
  })
})

describe('everything stricter still wins over an untrusted .plur.yaml', () => {
  it('a map off', () => {
    writeMap([{ path: repo, plur: 'off' }])
    expect(policy()).toEqual({ mode: 'off', remoteAllowed: false, source: 'map' })
  })

  it('a map remote-only, with the map scope and never the hint or its remote', () => {
    writeMap([{ path: repo, plur: 'remote-only', scope: 'group:team/eng' }])
    expect(policy()).toEqual({ mode: 'remote-only', scope: 'group:team/eng', remoteAllowed: false, source: 'map' })
  })

  it('an ask the user set', () => {
    writeMap([{ path: repo, plur: 'ask' }])
    expect(policy()).toEqual({ mode: 'ask', remoteAllowed: false, source: 'map' })
  })

  it('a folder map that cannot be read (fail safe: ask, no memory)', () => {
    writeFileSync(folderMapPath(root), 'version: 1\nfolders:\n  - path: [unclosed\n')
    expect(policy()).toMatchObject({ mode: 'ask', reason: 'malformed-map', remoteAllowed: false })
  })

  it('a .plur.yaml in $HOME is never read as a request, so it cannot switch memory on under home', () => {
    // The .plur.yaml walk refuses the real home folder (os.homedir()), so the
    // test's home has to be HOME for the guard to see it.
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      writeFileSync(join(home, '.plur.yaml'), 'scope: project:home\n')
      const notes = join(home, 'notes')
      mkdirSync(notes)
      // Its request is never read, so it cannot switch memory on (with or
      // without its settings) for the folders under home.
      expect(policy(notes)).toEqual({ mode: 'ask', remoteAllowed: false, source: 'default' })
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
    }
  })
})

describe('a trusted .plur.yaml is unchanged', () => {
  it('applies its scope, its domain and its remote', () => {
    writeMap([{ path: repo, trusted: true }])
    const p = policy()
    expect(p).toEqual({ mode: 'on', scope: 'project:hint', remoteAllowed: true, source: 'plur-yaml' })
    expect(sessionSettings(p, { domain: 'x.y' })).toEqual({ scope: 'project:hint', domain: 'x.y' })
  })
})
