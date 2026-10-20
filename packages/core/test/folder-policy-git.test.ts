import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { resolveFolderPolicy, saveFolderMap, type FolderEntry } from '../src/folders.js'
import type { GitScopeSource, OriginRead } from '../src/git-origin.js'

const scope = 'project:acme/team/backend'
let home: string, root: string, repo: string, source: GitScopeSource
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-git-policy-')))
  root = join(home, '.plur'); repo = join(home, 'repo')
  mkdirSync(root); mkdirSync(repo)
  source = { server: 'https://plur.example.com', gitlab_host: 'gitlab.example.com', status: 'ok',
    scopes: [scope], project_paths: { [scope]: 'team/backend' }, discovered_at: new Date().toISOString() }
})
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })
const origin = (): OriginRead => ({ kind: 'url', url: 'git@gitlab.example.com:team/backend.git' })
const map = (entry: Omit<FolderEntry, 'path'>) => saveFolderMap(root, { version: 1, folders: [{ path: repo, ...entry }] })
const policy = (readOrigin = origin) => resolveFolderPolicy(repo, { root, home, gitScopes: [source], readOrigin })

describe('git-origin folder defaults', () => {
  it('selects an authorized project without a folder entry', () => {
    expect(policy()).toMatchObject({ mode: 'on', scope, source: 'git', git: { kind: 'scope', scope } })
  })
  it.each(['off', 'remote-only', 'ask'] as const)('preserves an explicit %s decision without reading git', plur => {
    map({ plur, ...(plur === 'remote-only' ? { scope: 'group:acme/team' } : {}) })
    const read = vi.fn(origin)
    expect(policy(read).mode).toBe(plur)
    expect(read).not.toHaveBeenCalled()
  })
  it('preserves explicit scope and trusted legacy scope', () => {
    map({ scope: 'group:acme/team' })
    expect(policy()).toMatchObject({ scope: 'group:acme/team', source: 'map' })
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:legacy\n')
    map({ trusted: true })
    expect(policy()).toMatchObject({ scope: 'project:legacy', source: 'plur-yaml' })
  })
  it('fills an on decision that has no scope', () => {
    map({ plur: 'on' })
    expect(policy()).toMatchObject({ mode: 'on', scope, source: 'git' })
  })
  it('a malformed map never consults git', () => {
    writeFileSync(join(root, 'folders.yaml'), 'folders: [\n')
    const read = vi.fn(origin)
    expect(policy(read)).toMatchObject({ mode: 'ask', reason: 'malformed-map' })
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps an untrusted legacy request behind its trust decision', () => {
    mkdirSync(join(repo, '.git')); writeFileSync(join(repo, '.plur.yaml'), 'scope: project:legacy\n')
    const read = vi.fn(origin)
    expect(policy(read)).toMatchObject({ mode: 'ask', reason: 'untrusted-plur-yaml' })
    expect(read).not.toHaveBeenCalled()
  })
  it('unmatched origins stay on and local with a reason', () => {
    const result = policy(() => ({ kind: 'url', url: 'https://gitlab.example.com/team/other.git' }))
    expect(result).toMatchObject({ mode: 'on', source: 'git', git: { kind: 'local', reason: 'no-scope-for-project' } })
    expect(result.scope).toBeUndefined()
  })
  it('stale mappings are unknown, without a scope', () => {
    source.discovered_at = '2000-01-01T00:00:00Z'
    expect(policy()).toMatchObject({ mode: 'on', git: { kind: 'unknown', reason: 'cache-stale' } })
    expect(policy().scope).toBeUndefined()
  })
  it('the home directory, its ancestors and a filesystem root keep asking even when they are mapped repositories', () => {
    const read = vi.fn(origin)
    for (const dir of [home, join(home, '..'), '/']) {
      const decided = resolveFolderPolicy(dir, { root, home, gitScopes: [source], readOrigin: read })
      expect(decided, dir).toMatchObject({ mode: 'ask', source: 'default' })
      expect(decided.scope, dir).toBeUndefined()
    }
    expect(read).not.toHaveBeenCalled()
    expect(policy()).toMatchObject({ mode: 'on', source: 'git', scope })
  })
  it('non-repositories and installations without server entries still ask', () => {
    expect(policy(() => ({ kind: 'not-git' })).mode).toBe('ask')
    const read = vi.fn(origin)
    expect(resolveFolderPolicy(repo, { root, home, gitScopes: [], readOrigin: read }).mode).toBe('ask')
    expect(read).not.toHaveBeenCalled()
  })
  it('the engine caches the git read by canonical path for 30 seconds, but reads folder decisions each time', () => {
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/team/backend.git'])
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ stores: [{ url: source.server, token: 'fixture-token',
      scope: 'user:acme:alice', scopes: [scope], enterprise: {}, discovery: source }] }))
    const plur = new Plur({ path: root, autoDiscover: false })
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(plur.folderDefaultScope(repo)).toMatchObject({ mode: 'on', scope, git: { kind: 'scope' } })
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/team/other.git'])
    const link = join(home, 'link'); symlinkSync(repo, link, 'junction')
    expect(plur.folderDefaultScope(link).scope).toBe(scope)
    map({ plur: 'off' }); expect(plur.resolveFolderPolicy(repo).mode).toBe('off')
    saveFolderMap(root, { version: 1, folders: [] })
    clock.mockReturnValue(now + 30_001)
    expect(plur.folderDefaultScope(repo)).toMatchObject({ scope: null, git: { kind: 'local' } })
  })
})
