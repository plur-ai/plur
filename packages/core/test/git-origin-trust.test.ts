// Security audit 2026-11-06: a folder's own .git/config is repository content,
// like a .plur.yaml. Its origin must not pick the team scope that unscoped
// memories are pushed to unless the user trusted the repository.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveFolderPolicy, saveFolderMap, type FolderEntry } from '../src/folders.js'
import type { GitScopeSource, OriginRead } from '../src/git-origin.js'

const scope = 'project:acme/team/backend'
let home: string, root: string, repo: string, source: GitScopeSource
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-git-trust-')))
  root = join(home, '.plur'); repo = join(home, 'repo')
  mkdirSync(root); mkdirSync(repo)
  // A hand-written .git, as an archive or a copied folder would carry.
  mkdirSync(join(repo, '.git'))
  source = { server: 'https://plur.example.invalid', gitlab_host: 'gitlab.example.invalid', status: 'ok',
    scopes: [scope], project_paths: { [scope]: 'team/backend' }, discovered_at: new Date().toISOString() }
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
const origin = (): OriginRead => ({ kind: 'url', url: 'git@gitlab.example.invalid:team/backend.git' })
const map = (entry: Omit<FolderEntry, 'path'>) => saveFolderMap(root, { version: 1, folders: [{ path: repo, ...entry }] })
const policy = () => resolveFolderPolicy(repo, { root, home, gitScopes: [source], readOrigin: origin })

describe('git-origin team scope needs a trusted repository', () => {
  it('an untrusted, undecided repository does not get the origin scope; it stays an ask that names it', () => {
    const p = policy()
    expect(p.scope).toBeUndefined()
    expect(p.mode).toBe('ask')
    expect(p.git?.kind).not.toBe('scope')
    expect(p.requested?.scope).toBe(scope)
  })
  it('an untrusted repository the user turned on stays local', () => {
    map({ plur: 'on' })
    const p = policy()
    expect(p.mode).toBe('on')
    expect(p.scope).toBeUndefined()
    expect(p.git).toMatchObject({ kind: 'local', reason: 'untrusted-origin' })
  })
  it('a trusted repository gets the origin scope as before', () => {
    map({ trusted: true })
    expect(policy()).toMatchObject({ mode: 'on', source: 'git', scope, git: { kind: 'scope', scope } })
  })
})
