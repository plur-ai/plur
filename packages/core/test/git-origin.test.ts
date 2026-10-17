import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { isolateGitConfig } from './helpers/git-isolation.js'
import { parseGitRemoteUrl, readGitOrigin } from '../src/git-origin.js'

// ── helpers ────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'plur-git-origin-'))
}

function initRepo(dir: string): void {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' })
}

function setOrigin(dir: string, url: string): void {
  spawnSync('git', ['remote', 'add', 'origin', url], { cwd: dir, encoding: 'utf8' })
}

// ── parseGitRemoteUrl ──────────────────────────────────────────────────────

describe('parseGitRemoteUrl', () => {
  it.each([
    [
      'https://gitlab.example.com/team/backend.git',
      { protocol: 'https', host: 'gitlab.example.com', path: 'team/backend' },
    ],
    [
      'https://GitLab.Example.com:8443/team/sub/backend',
      { protocol: 'https', host: 'gitlab.example.com', port: 8443, path: 'team/sub/backend' },
    ],
    [
      'ssh://git@gitlab.example.com:2222/team/backend.git',
      { protocol: 'ssh', host: 'gitlab.example.com', port: 2222, path: 'team/backend' },
    ],
    [
      'git@gitlab.example.com:team/backend.git',
      { protocol: 'scp', host: 'gitlab.example.com', path: 'team/backend' },
    ],
    [
      'https://gitlab.example.com/team/backend/',
      { protocol: 'https', host: 'gitlab.example.com', path: 'team/backend' },
    ],
    [
      'http://gitlab.example.com/team/backend.git',
      { protocol: 'http', host: 'gitlab.example.com', path: 'team/backend' },
    ],
    [
      'git+ssh://git@gitlab.example.com/team/backend.git',
      { protocol: 'ssh', host: 'gitlab.example.com', path: 'team/backend' },
    ],
    [
      'ssh://git@gitlab.example.com/acme/team/sub/backend.git',
      { protocol: 'ssh', host: 'gitlab.example.com', path: 'acme/team/sub/backend' },
    ],
    [
      'git@gitlab.example.com:acme/team/sub/backend.git',
      { protocol: 'scp', host: 'gitlab.example.com', path: 'acme/team/sub/backend' },
    ],
    [
      'git@gitlab.example.com:/acme/team/backend.git',
      { protocol: 'scp', host: 'gitlab.example.com', path: 'acme/team/backend' },
    ],
  ])('parses %s', (url, want) => {
    expect(parseGitRemoteUrl(url)).toEqual(want)
  })

  it.each([
    '/srv/git/backend.git',
    'file:///srv/git/backend.git',
    'C:\\repos\\backend',
    '',
  ])('rejects %s', (u) => {
    expect(parseGitRemoteUrl(u)).toBeNull()
  })

  it('credentials in origin never leak', () => {
    const p = parseGitRemoteUrl(
      'https://alice:glpat-secret@gitlab.example.com/acme/team/backend.git',
    )!
    expect(p).not.toBeNull()
    expect(p).toEqual({ protocol: 'https', host: 'gitlab.example.com', path: 'acme/team/backend' })
    expect(JSON.stringify(p)).not.toContain('glpat-secret')
    expect(JSON.stringify(p)).not.toContain('alice')
  })

  it('discards userinfo with no password (user only)', () => {
    const p = parseGitRemoteUrl('https://alice@gitlab.example.com/acme/team/backend.git')!
    expect(p).toEqual({ protocol: 'https', host: 'gitlab.example.com', path: 'acme/team/backend' })
    expect(JSON.stringify(p)).not.toContain('alice')
  })
})

// ── readGitOrigin ──────────────────────────────────────────────────────────

describe('readGitOrigin', () => {
  isolateGitConfig()

  let tmpNoGit: string
  let repoDir: string

  beforeEach(() => {
    tmpNoGit = makeTmp()
    repoDir = makeTmp()
    initRepo(repoDir)
  })

  afterEach(() => {
    rmSync(tmpNoGit, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('not a git repo', () => {
    expect(readGitOrigin(tmpNoGit)).toEqual({ kind: 'not-git' })
  })

  it('a real repo with no origin', () => {
    expect(readGitOrigin(repoDir)).toEqual({ kind: 'no-remote' })
  })

  it('returns the configured url', () => {
    setOrigin(repoDir, 'https://gitlab.example.com/team/backend.git')
    const r = readGitOrigin(repoDir)
    expect(r).toEqual({ kind: 'url', url: 'https://gitlab.example.com/team/backend.git' })
  })

  it('insteadOf is ignored: the configured url is returned', () => {
    setOrigin(repoDir, 'https://gitlab.example.com/team/backend.git')
    spawnSync(
      'git',
      ['config', 'url.git@mirror.example.com:.insteadOf', 'https://gitlab.example.com/'],
      { cwd: repoDir, encoding: 'utf8' },
    )
    const r = readGitOrigin(repoDir)
    expect(r).toEqual({ kind: 'url', url: 'https://gitlab.example.com/team/backend.git' })
  })

  it('folder path with spaces', () => {
    const parent = makeTmp()
    const repoInSpacy = join(parent, 'My Repos', 'backend')
    mkdirSync(repoInSpacy, { recursive: true })
    initRepo(repoInSpacy)
    setOrigin(repoInSpacy, 'https://gitlab.example.com/team/backend.git')
    const r = readGitOrigin(repoInSpacy)
    expect(r).toEqual({ kind: 'url', url: 'https://gitlab.example.com/team/backend.git' })
    rmSync(parent, { recursive: true, force: true })
  })

  it('a relative path to a folder outside any repo is not-git, even when the cwd is in a repo', () => {
    // The test process runs inside the plur checkout, so a lexical walk up a
    // relative path ends at '.', which IS a git repo. The walk must resolve first.
    const rel = relative(process.cwd(), tmpNoGit)
    expect(readGitOrigin(rel)).toEqual({ kind: 'not-git' })
  })

  it('a spawn failure other than ENOENT or timeout is not reported as a timeout', () => {
    const r = readGitOrigin(repoDir, () => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' }),
    }))
    expect(r.kind).toBe('error')
    expect((r as { kind: 'error'; detail: string }).detail).not.toMatch(/timed out/)
  })

  it('git missing → error, detail without the url', () => {
    const r = readGitOrigin(repoDir, () => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    }))
    expect(r).toEqual({ kind: 'error', detail: 'git is not installed or not on PATH' })
  })

  it('git timeout → error, no url in detail', () => {
    setOrigin(repoDir, 'https://alice:glpat-secret@gitlab.example.com/acme/team/backend.git')
    const r = readGitOrigin(repoDir, () => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawnSync timeout'), { code: 'ETIMEDOUT' }),
    }))
    expect(r.kind).toBe('error')
    expect((r as { kind: 'error'; detail: string }).detail).not.toContain('glpat-secret')
    expect((r as { kind: 'error'; detail: string }).detail).not.toContain('alice')
  })

  it('walks up from a subdirectory to find the .git dir', () => {
    setOrigin(repoDir, 'https://gitlab.example.com/team/backend.git')
    const subDir = join(repoDir, 'src', 'lib')
    mkdirSync(subDir, { recursive: true })
    const r = readGitOrigin(subDir)
    expect(r).toEqual({ kind: 'url', url: 'https://gitlab.example.com/team/backend.git' })
  })
})
