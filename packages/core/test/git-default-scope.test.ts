/**
 * gitDefaultScope and loadGitScopeSources (#1632): the default scope of a git
 * repo comes from its `origin` remote and the project mapping the company
 * server sent in its last /api/v1/me answer. Pure: `read` is injected, and
 * loadGitScopeSources reads config.yaml only (no network).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import {
  gitDefaultScope, loadGitScopeSources, DISCOVERY_MAX_AGE_MS, type GitScopeSource,
} from '../src/git-origin.js'

const SRC: GitScopeSource = {
  server: 'https://plur.example.com', gitlab_host: 'gitlab.example.com', status: 'ok',
  discovered_at: '2026-10-16T12:00:00Z', scopes: ['project:acme/team/backend'],
  project_paths: { 'project:acme/team/backend': 'team/backend' },
}
const now = Date.parse('2026-10-17T00:00:00Z')
const at = (url: string) => () => ({ kind: 'url' as const, url })
const BACKEND = 'https://gitlab.example.com/team/backend'

describe('gitDefaultScope', () => {
  it('ssh origin maps to the project scope', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('git@gitlab.example.com:team/backend.git') }))
      .toEqual({ kind: 'scope', scope: 'project:acme/team/backend', server: 'https://plur.example.com' }))

  it('https origin with credentials maps, and the outcome never carries them', () => {
    const o = gitDefaultScope('/r', [SRC], { now, read: at('https://alice:glpat-secret@gitlab.example.com/team/backend.git') })
    expect(o).toEqual({ kind: 'scope', scope: 'project:acme/team/backend', server: 'https://plur.example.com' })
    expect(JSON.stringify(o)).not.toContain('glpat-secret')
  })

  it('host must match exactly', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('https://gitlab.example.com.evil.example/team/backend') }))
      .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))

  it('a host that only ends with the company host does not match', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('https://evilgitlab.example.com/team/backend') }))
      .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))

  it('host compare is case-insensitive', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('https://GitLab.Example.COM/team/backend') }))
      .toMatchObject({ kind: 'scope' }))

  it('path compare is case-insensitive', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('https://gitlab.example.com/Team/Backend.git') }))
      .toMatchObject({ kind: 'scope', scope: 'project:acme/team/backend' }))

  it('no scope for this project', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('https://gitlab.example.com/team/other.git') }))
      .toEqual({ kind: 'local', reason: 'no-scope-for-project' }))

  it('a parent path is not the project', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('https://gitlab.example.com/team') }))
      .toEqual({ kind: 'local', reason: 'no-scope-for-project' }))

  it('a mapping whose scope the server did not list is ignored', () =>
    expect(gitDefaultScope('/r', [{ ...SRC, scopes: [] }], { now, read: at(BACKEND) }))
      .toEqual({ kind: 'local', reason: 'no-scope-for-project' }))

  it('a stale cache is unknown, not local', () =>
    expect(gitDefaultScope('/r', [SRC], { now: Date.parse('2026-11-01T00:00:00Z'), read: at(BACKEND) }))
      .toEqual({ kind: 'unknown', reason: 'cache-stale' }))

  it('exactly the maximum age is still fresh; one ms more is stale', () => {
    const t = Date.parse(SRC.discovered_at!)
    expect(gitDefaultScope('/r', [SRC], { now: t + DISCOVERY_MAX_AGE_MS, read: at(BACKEND) })).toMatchObject({ kind: 'scope' })
    expect(gitDefaultScope('/r', [SRC], { now: t + DISCOVERY_MAX_AGE_MS + 1, read: at(BACKEND) }))
      .toEqual({ kind: 'unknown', reason: 'cache-stale' })
  })

  it('future or unparsable discovered_at is stale', () => {
    for (const d of ['2027-01-01T00:00:00Z', 'yesterday'])
      expect(gitDefaultScope('/r', [{ ...SRC, discovered_at: d }], { now, read: at(BACKEND) }))
        .toEqual({ kind: 'unknown', reason: 'cache-stale' })
  })

  it('up to one day in the future is tolerated (clock skew)', () =>
    expect(gitDefaultScope('/r', [{ ...SRC, discovered_at: '2026-10-17T23:00:00Z' }], { now, read: at(BACKEND) }))
      .toMatchObject({ kind: 'scope' }))

  it('never discovered → scopes-unavailable', () =>
    expect(gitDefaultScope('/r', [{ ...SRC, status: 'never', discovered_at: undefined, scopes: [], project_paths: {} }], { now, read: at(BACKEND) }))
      .toEqual({ kind: 'unknown', reason: 'scopes-unavailable' }))

  it('failed discovery with no cache → scopes-unavailable', () => {
    for (const status of ['failed', 'auth_failed', 'degraded'] as const)
      expect(gitDefaultScope('/r', [{ ...SRC, status, discovered_at: undefined }], { now, read: at(BACKEND) }))
        .toEqual({ kind: 'unknown', reason: 'scopes-unavailable' })
  })

  // A server that has not synced this account yet answers scopes_status
  // not_synced with no scopes; discovery stores that with a discovered_at. The
  // rule makes only a missing discovered_at 'scopes-unavailable', so the repo is
  // local with no project scope (the session line names not_synced on its own).
  it('not_synced with no scopes and a fresh discovered_at → local, no scope for project', () =>
    expect(gitDefaultScope('/r', [{ ...SRC, status: 'not_synced', scopes: [], project_paths: {} }], { now, read: at(BACKEND) }))
      .toEqual({ kind: 'local', reason: 'no-scope-for-project' }))

  it('a failed refresh over a fresh cache still uses the cache', () =>
    expect(gitDefaultScope('/r', [{ ...SRC, status: 'failed' }], { now, read: at(BACKEND) }))
      .toMatchObject({ kind: 'scope', scope: 'project:acme/team/backend' }))

  it('two scopes for one path → ambiguous', () =>
    expect(gitDefaultScope('/r', [{
      ...SRC, scopes: ['project:acme/team/backend', 'project:acme/team/backend-2'],
      project_paths: { 'project:acme/team/backend': 'team/backend', 'project:acme/team/backend-2': 'Team/Backend' },
    }], { now, read: at(BACKEND) })).toEqual({ kind: 'unknown', reason: 'ambiguous-mapping' }))

  it('two servers mapping the same path → ambiguous', () =>
    expect(gitDefaultScope('/r', [SRC, { ...SRC, server: 'https://plur2.example.com' }], { now, read: at(BACKEND) }))
      .toEqual({ kind: 'unknown', reason: 'ambiguous-mapping' }))

  it('a stale second server on the same GitLab makes the answer unknown, never a guess', () =>
    expect(gitDefaultScope('/r', [SRC, { ...SRC, server: 'https://plur2.example.com', scopes: [], project_paths: {}, discovered_at: '2026-01-01T00:00:00Z' }], { now, read: at(BACKEND) }))
      .toEqual({ kind: 'unknown', reason: 'cache-stale' }))

  it('a server on another GitLab is not consulted', () =>
    expect(gitDefaultScope('/r', [SRC, { ...SRC, server: 'https://plur2.example.com', gitlab_host: 'git.other.example', discovered_at: 'yesterday' }], { now, read: at(BACKEND) }))
      .toMatchObject({ kind: 'scope', server: 'https://plur.example.com' }))

  it('a source without a GitLab host matches nothing', () =>
    expect(gitDefaultScope('/r', [{ ...SRC, gitlab_host: null }], { now, read: at(BACKEND) }))
      .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))

  it('git unreadable → unknown', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: () => ({ kind: 'error', detail: 'x' }) }))
      .toEqual({ kind: 'unknown', reason: 'git-unreadable' }))

  it('not a git repo', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: () => ({ kind: 'not-git' }) })).toEqual({ kind: 'not-git' }))

  it('no origin remote → local', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: () => ({ kind: 'no-remote' }) }))
      .toEqual({ kind: 'local', reason: 'no-remote' }))

  it('an unparsable origin → local, not company GitLab', () =>
    expect(gitDefaultScope('/r', [SRC], { now, read: at('/srv/git/backend.git') }))
      .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))

  describe('ports', () => {
    const P: GitScopeSource = { ...SRC, gitlab_host: 'gitlab.example.com:8443' }
    it('https with the same port matches', () =>
      expect(gitDefaultScope('/r', [P], { now, read: at('https://gitlab.example.com:8443/team/backend') })).toMatchObject({ kind: 'scope' }))
    it('https with another port does not', () =>
      expect(gitDefaultScope('/r', [P], { now, read: at('https://gitlab.example.com:9443/team/backend') }))
        .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))
    it('https with no port is port 443, not 8443', () =>
      expect(gitDefaultScope('/r', [P], { now, read: at('https://gitlab.example.com/team/backend') }))
        .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))
    it('a gitlab_host with :443 matches an https origin with no port (the default port)', () =>
      expect(gitDefaultScope('/r', [{ ...SRC, gitlab_host: 'gitlab.example.com:443' }], { now, read: at(BACKEND) })).toMatchObject({ kind: 'scope' }))
    it('ssh ports are not compared (the GitLab web port is not its ssh port)', () => {
      expect(gitDefaultScope('/r', [P], { now, read: at('ssh://git@gitlab.example.com:2222/team/backend.git') })).toMatchObject({ kind: 'scope' })
      expect(gitDefaultScope('/r', [P], { now, read: at('git@gitlab.example.com:team/backend.git') })).toMatchObject({ kind: 'scope' })
    })
    it('a gitlab_host without a port matches any https port', () =>
      expect(gitDefaultScope('/r', [SRC], { now, read: at('https://gitlab.example.com:8443/team/backend') })).toMatchObject({ kind: 'scope' }))
  })

  describe('bracketed IPv6 GitLab host', () => {
    const V6: GitScopeSource = { ...SRC, gitlab_host: '[2001:db8::1]:8443' }
    it('matches an https origin on the same address and port', () =>
      expect(gitDefaultScope('/r', [V6], { now, read: at('https://[2001:db8::1]:8443/team/backend.git') }))
        .toEqual({ kind: 'scope', scope: 'project:acme/team/backend', server: 'https://plur.example.com' }))
    it('matches a non-canonical spelling of the same address', () =>
      expect(gitDefaultScope('/r', [V6], { now, read: at('https://[2001:DB8:0::1]:8443/team/backend.git') })).toMatchObject({ kind: 'scope' }))
    it('matches an ssh:// origin', () =>
      expect(gitDefaultScope('/r', [{ ...SRC, gitlab_host: '[2001:db8::1]' }], { now, read: at('ssh://git@[2001:db8::1]:2222/team/backend.git') }))
        .toMatchObject({ kind: 'scope' }))
    it('matches an scp-style origin (git@[addr]:path)', () =>
      expect(gitDefaultScope('/r', [{ ...SRC, gitlab_host: '[2001:db8::1]' }], { now, read: at('git@[2001:DB8::1]:team/backend.git') }))
        .toEqual({ kind: 'scope', scope: 'project:acme/team/backend', server: 'https://plur.example.com' }))
    it('another address does not match', () =>
      expect(gitDefaultScope('/r', [V6], { now, read: at('https://[2001:db8::2]:8443/team/backend.git') }))
        .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))
    it('another port does not match', () =>
      expect(gitDefaultScope('/r', [V6], { now, read: at('https://[2001:db8::1]/team/backend.git') }))
        .toEqual({ kind: 'local', reason: 'not-company-gitlab' }))
  })

  it('a gitlab_host outside the host grammar matches nothing', () => {
    for (const h of ['gitlab.example.com/team', 'alice@gitlab.example.com', '[2001:DB8::1]', 'gitlab.example.com:99999', ''])
      expect(gitDefaultScope('/r', [{ ...SRC, gitlab_host: h }], { now, read: at(BACKEND) }))
        .toEqual({ kind: 'local', reason: 'not-company-gitlab' })
  })
})

describe('loadGitScopeSources', () => {
  let root: string | undefined
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined })
  const withConfig = (cfg: unknown): string => {
    root = mkdtempSync(join(tmpdir(), 'plur-git-sources-'))
    writeFileSync(join(root, 'config.yaml'), typeof cfg === 'string' ? cfg : yaml.dump(cfg))
    return root
  }

  it('reads a server entry: canonical server, scopes, and the discovery cache', () => {
    const r = withConfig({ stores: [{
      url: 'https://alice:pw@PLUR.example.com:443/', token: 'k1', scope: 'user:acme:alice', enterprise: {},
      scopes: ['user:acme:alice', 'project:acme/team/backend'], pinned_scopes: ['group:acme/legacy'],
      discovery: { status: 'ok', scopes_status: 'ok', discovered_at: '2026-10-16T12:00:00Z', gitlab_host: 'gitlab.example.com',
        project_paths: { 'project:acme/team/backend': 'team/backend' }, username: 'alice', org_id: 'acme' },
    }] })
    const s = loadGitScopeSources(r)
    expect(s).toEqual([{
      server: 'https://plur.example.com', gitlab_host: 'gitlab.example.com', status: 'ok', discovered_at: '2026-10-16T12:00:00Z',
      scopes: ['user:acme:alice', 'project:acme/team/backend'], project_paths: { 'project:acme/team/backend': 'team/backend' },
    }])
    expect(JSON.stringify(s)).not.toContain('k1')
    expect(JSON.stringify(s)).not.toContain('pw')
    expect(gitDefaultScope('/r', s, { now, read: at(BACKEND) }))
      .toEqual({ kind: 'scope', scope: 'project:acme/team/backend', server: 'https://plur.example.com' })
  })

  it('a pinned scope the server did not list is never a default', () => {
    const r = withConfig({ stores: [{
      url: 'https://plur.example.com', token: 'k1', enterprise: {}, scopes: [], pinned_scopes: ['project:acme/team/backend'],
      discovery: { status: 'ok', discovered_at: '2026-10-16T12:00:00Z', gitlab_host: 'gitlab.example.com',
        project_paths: { 'project:acme/team/backend': 'team/backend' } },
    }] })
    expect(gitDefaultScope('/r', loadGitScopeSources(r), { now, read: at(BACKEND) }))
      .toEqual({ kind: 'local', reason: 'no-scope-for-project' })
  })

  it('a server entry with no discovery yet is status never', () => {
    const r = withConfig({ stores: [{ url: 'https://plur.example.com', token: 'k1', enterprise: {}, scopes: [] }] })
    expect(loadGitScopeSources(r)).toEqual([{ server: 'https://plur.example.com', gitlab_host: null, status: 'never', scopes: [], project_paths: {} }])
  })

  it('per-scope entries and entries without an enterprise block are not sources', () => {
    const r = withConfig({ stores: [
      { url: 'https://plur.example.com', token: 'k1', scope: 'group:acme/team' },
      { url: 'https://plur.example.com', token: 'k1', scopes: ['group:acme/team'] },
      { path: '/tmp/x', scope: 'project:acme/team/backend' },
    ] })
    expect(loadGitScopeSources(r)).toEqual([])
  })

  it('hand-edited junk is dropped field by field, never thrown', () => {
    const r = withConfig({ stores: [{
      url: 'https://plur.example.com', enterprise: {}, scopes: ['project:acme/team/backend', 7, null],
      discovery: { status: 'weird', discovered_at: 12, gitlab_host: 'gitlab.example.com/evil',
        project_paths: { 'project:acme/team/backend': 'team/backend', 'project:acme/x': 5 } },
    }] })
    expect(loadGitScopeSources(r)).toEqual([{ server: 'https://plur.example.com', gitlab_host: null, status: 'never',
      scopes: ['project:acme/team/backend'], project_paths: { 'project:acme/team/backend': 'team/backend' } }])
  })

  const FRESH_A = {
    url: 'https://plur-a.example.com', token: 'k1', enterprise: {}, scopes: ['project:acme/team/backend'],
    discovery: { status: 'ok', discovered_at: '2026-10-16T12:00:00Z', gitlab_host: 'gitlab.example.com',
      project_paths: { 'project:acme/team/backend': 'team/backend' } },
  }

  it('a server entry with a malformed scopes list still counts: its stale cache makes the answer unknown', () => {
    const r = withConfig({ stores: [FRESH_A, {
      url: 'https://plur-b.example.com', token: 'k2', enterprise: {}, scopes: 'oops',
      discovery: { status: 'ok', discovered_at: '2026-01-01T00:00:00Z', gitlab_host: 'gitlab.example.com', project_paths: {} },
    }] })
    expect(loadGitScopeSources(r)[1]).toMatchObject({ server: 'https://plur-b.example.com', scopes: [] })
    expect(gitDefaultScope('/r', loadGitScopeSources(r), { now, read: at(BACKEND) }))
      .toEqual({ kind: 'unknown', reason: 'cache-stale' })
  })

  it('a server url that is not a valid http(s) url never reaches a source or outcome, and never yields a scope', () => {
    for (const url of ['https://alice:FAKE-SECRET@plur.example.com:bad', 'ssh://alice:FAKE-SECRET@plur.example.com']) {
      const r = withConfig({ stores: [{ ...FRESH_A, url }] })
      const s = loadGitScopeSources(r)
      expect(s).toHaveLength(1)
      expect(JSON.stringify(s)).not.toContain('FAKE-SECRET')
      const o = gitDefaultScope('/r', s, { now, read: at(BACKEND) })
      expect(o).toEqual({ kind: 'local', reason: 'no-scope-for-project' })
      // Its stale cache still counts against another server's fresh mapping.
      const r2 = withConfig({ stores: [FRESH_A, { ...FRESH_A, url, discovery: { ...FRESH_A.discovery, discovered_at: '2026-01-01T00:00:00Z' } }] })
      expect(gitDefaultScope('/r', loadGitScopeSources(r2), { now, read: at(BACKEND) })).toEqual({ kind: 'unknown', reason: 'cache-stale' })
    }
  })

  it('no config.yaml, unparsable YAML, or no stores → []', () => {
    root = mkdtempSync(join(tmpdir(), 'plur-git-sources-'))
    expect(loadGitScopeSources(root)).toEqual([])
    writeFileSync(join(root, 'config.yaml'), 'stores: [unclosed')
    expect(loadGitScopeSources(root)).toEqual([])
    writeFileSync(join(root, 'config.yaml'), 'llm: {}\n')
    expect(loadGitScopeSources(root)).toEqual([])
  })
})
