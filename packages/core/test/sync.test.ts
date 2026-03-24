import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { sync, getSyncStatus } from '../src/sync.js'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim()
}

describe('sync', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-sync-'))
    // Create a minimal PLUR directory with an engrams file
    writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-001\n  statement: test\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('getSyncStatus', () => {
    it('returns uninitialized for non-git directory', () => {
      const status = getSyncStatus(dir)
      expect(status.initialized).toBe(false)
      expect(status.remote).toBeNull()
    })

    it('returns initialized after sync', () => {
      sync(dir)
      const status = getSyncStatus(dir)
      expect(status.initialized).toBe(true)
      expect(status.remote).toBeNull()
      expect(status.dirty).toBe(false)
      expect(status.branch).toBe('main')
    })

    it('detects dirty state', () => {
      sync(dir)
      writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-002\n  statement: new\n')
      const status = getSyncStatus(dir)
      expect(status.dirty).toBe(true)
    })
  })

  describe('init', () => {
    it('initializes git repo on first sync', () => {
      const result = sync(dir)
      expect(result.action).toBe('initialized')
      expect(existsSync(join(dir, '.git'))).toBe(true)
      expect(existsSync(join(dir, '.gitignore'))).toBe(true)
    })

    it('creates .gitignore with correct entries', () => {
      sync(dir)
      const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('embeddings/')
      expect(gitignore).toContain('*.db')
      expect(gitignore).toContain('exchange/')
    })

    it('commits all existing files', () => {
      sync(dir)
      const log = git('log --oneline', dir)
      expect(log).toContain('Initial PLUR engram store')
    })
  })

  describe('local commits', () => {
    it('commits new changes on subsequent sync', () => {
      sync(dir)
      writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-001\n  statement: updated\n')
      const result = sync(dir)
      expect(result.action).toBe('committed')
      expect(result.files_changed).toBe(1)
    })

    it('returns up-to-date when nothing changed', () => {
      sync(dir)
      const result = sync(dir)
      expect(result.action).toBe('up-to-date')
      expect(result.files_changed).toBe(0)
    })
  })

  describe('remote sync', () => {
    let bareRemote: string

    beforeEach(() => {
      bareRemote = mkdtempSync(join(tmpdir(), 'plur-remote-'))
      execSync('git init --bare', { cwd: bareRemote })
    })

    afterEach(() => {
      rmSync(bareRemote, { recursive: true, force: true })
    })

    it('adds remote and pushes on first sync with remote', () => {
      const result = sync(dir, bareRemote)
      expect(result.action).toBe('initialized')
      expect(result.remote).toBe(bareRemote)
      // Verify remote has the commit
      const log = execSync(`git log --oneline`, { cwd: bareRemote, encoding: 'utf8' })
      expect(log).toContain('Initial PLUR engram store')
    })

    it('adds remote to existing local repo', () => {
      sync(dir) // init without remote
      const result = sync(dir, bareRemote)
      expect(result.action).toBe('synced')
      expect(result.remote).toBe(bareRemote)
    })

    it('pushes new commits to remote', () => {
      sync(dir, bareRemote)
      writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-002\n  statement: new\n')
      const result = sync(dir)
      expect(result.action).toBe('synced')
      // Verify remote has 2 commits
      const log = execSync(`git log --oneline`, { cwd: bareRemote, encoding: 'utf8' })
      expect(log.split('\n').length).toBeGreaterThanOrEqual(2)
    })

    it('pulls remote changes', () => {
      // Set up: init with remote, clone to second dir, push from second
      sync(dir, bareRemote)
      const dir2 = mkdtempSync(join(tmpdir(), 'plur-sync2-'))
      execSync(`git clone ${bareRemote} .`, { cwd: dir2 })
      writeFileSync(join(dir2, 'episodes.yaml'), '- id: EP-001\n  summary: remote episode\n')
      git('add -A', dir2)
      git('commit -m "remote change"', dir2)
      git('push', dir2)

      // Now sync original — should pull the remote change
      const result = sync(dir)
      expect(result.action).toBe('synced')
      expect(existsSync(join(dir, 'episodes.yaml'))).toBe(true)

      rmSync(dir2, { recursive: true, force: true })
    })

    it('handles concurrent changes (both sides modified)', () => {
      sync(dir, bareRemote)
      const dir2 = mkdtempSync(join(tmpdir(), 'plur-sync3-'))
      execSync(`git clone ${bareRemote} .`, { cwd: dir2 })

      // Modify different files on each side
      writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-LOCAL\n  statement: local change\n')
      writeFileSync(join(dir2, 'episodes.yaml'), '- id: EP-REMOTE\n  summary: remote change\n')
      git('add -A', dir2)
      git('commit -m "remote side"', dir2)
      git('push', dir2)

      // Sync original — should commit local, pull remote, push both
      const result = sync(dir)
      expect(result.action).toBe('synced')
      expect(existsSync(join(dir, 'episodes.yaml'))).toBe(true)

      rmSync(dir2, { recursive: true, force: true })
    })
  })
})
