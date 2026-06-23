import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { sync, getSyncStatus } from '../src/sync.js'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim()
}

describe('sync', () => {
  let dir: string
  let tmpConfigDir: string
  let origGitConfigGlobal: string | undefined
  let origGitConfigSystem: string | undefined

  beforeAll(() => {
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    origGitConfigSystem = process.env.GIT_CONFIG_SYSTEM
    // Isolate all git operations from the developer's global/system config.
    // Without this, a global gitignore containing engrams.yaml/episodes.yaml
    // silently drops those files from git add -A, causing 6 test failures and
    // the same latent data-loss bug in plur sync itself (see issue #329).
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'plur-gitconfig-'))
    const configFile = join(tmpConfigDir, 'gitconfig')
    writeFileSync(configFile, '[user]\n  name = PLUR Test\n  email = test@plur.ai\n')
    process.env.GIT_CONFIG_GLOBAL = configFile
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  })

  afterAll(() => {
    if (origGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal
    if (origGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
    else process.env.GIT_CONFIG_SYSTEM = origGitConfigSystem
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

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
      expect(['main', 'master']).toContain(status.branch)
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
      // Secrets must be ignored so they never ride along into a synced repo (#380).
      expect(gitignore).toContain('config.yaml')
      expect(gitignore).toContain('secrets.yaml')
      expect(gitignore).toContain('agent-keystore.json')
    })

    it('commits all existing files', () => {
      sync(dir)
      const log = git('log --oneline', dir)
      expect(log).toContain('Initial PLUR engram store')
    })

    it('does not neutralize the user global excludes with /dev/null (#384)', () => {
      sync(dir)
      let val = ''
      try { val = git('config --local --get core.excludesFile', dir) } catch { val = '' }
      expect(val).not.toBe('/dev/null')
    })
  })

  describe('secret safety (#380, #384)', () => {
    const TOKEN = 'eyJSECRETtokenABC123'
    const configWithToken = `stores:\n  - url: https://plur.datafund.io\n    token: ${TOKEN}\n    scope: group:plur/plur-ai/engineering\n`

    it('never commits config.yaml even when it holds a Bearer token', () => {
      writeFileSync(join(dir, 'config.yaml'), configWithToken)
      sync(dir)
      // config.yaml must not be tracked...
      expect(git('ls-files', dir).split('\n')).not.toContain('config.yaml')
      // ...and no committed blob may contain the token.
      const history = git('log -p --all', dir)
      expect(history).not.toContain(TOKEN)
    })

    it('untracks a config.yaml committed by a vulnerable client on the next sync', () => {
      // Reproduce the pre-fix state: a repo that already committed the secret.
      git('init', dir)
      writeFileSync(join(dir, 'config.yaml'), configWithToken)
      git('add -A -f', dir)
      git('commit -m "legacy commit with secret"', dir)
      expect(git('ls-files', dir).split('\n')).toContain('config.yaml')
      // The fixed sync untracks it (stops the bleeding; history purge is operational).
      writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-002\n  statement: new\n')
      sync(dir)
      expect(git('ls-files', dir).split('\n')).not.toContain('config.yaml')
    })

    it('untracks an agent-keystore.json committed by a vulnerable client on the next sync (#392)', () => {
      // The 2026-06 incident exposed agent-keystore.json (an encrypted agent key)
      // the same way as config.yaml — committed to the store repo and pushed.
      git('init', dir)
      writeFileSync(join(dir, 'agent-keystore.json'), '{"address":"x.eth","crypto":{"ciphertext":"deadbeef"}}')
      git('add -A -f', dir)
      git('commit -m "legacy commit with keystore"', dir)
      expect(git('ls-files', dir).split('\n')).toContain('agent-keystore.json')
      writeFileSync(join(dir, 'engrams.yaml'), '- id: ENG-003\n  statement: new\n')
      sync(dir)
      expect(git('ls-files', dir).split('\n')).not.toContain('agent-keystore.json')
    })

    it('does not commit machine-local derived files (engrams.db, store.pglite/)', () => {
      writeFileSync(join(dir, 'engrams.db'), 'binary-ish')
      writeFileSync(join(dir, 'secrets.yaml'), 'token: nope\n')
      sync(dir)
      const tracked = git('ls-files', dir).split('\n')
      expect(tracked).not.toContain('engrams.db')
      expect(tracked).not.toContain('secrets.yaml')
    })

    it('force-stages a new engram file even when an excludes file would ignore it (#329)', () => {
      // A user whose git excludes file ignores engram files must still get them synced.
      git('init', dir)
      const excludes = join(dir, '.git', 'plur-excludes')
      writeFileSync(excludes, 'engrams.yaml\nepisodes.yaml\n')
      git(`config --local core.excludesFile ${excludes}`, dir)
      // engrams.yaml (from beforeEach) is untracked and matched by the excludes file.
      sync(dir)
      expect(git('ls-files', dir).split('\n')).toContain('engrams.yaml')
    })

    it('never commits a secret nested inside a pack dir (#387 review)', () => {
      // `packs` is force-added (-f), so .gitignore can't stop a secret inside a
      // pack — and packs come from untrusted sources. The exclude-pathspecs must.
      const packDir = join(dir, 'packs', 'evil-pack')
      mkdirSync(packDir, { recursive: true })
      writeFileSync(join(packDir, 'SKILL.md'), '---\nname: evil-pack\n---\n')
      writeFileSync(join(packDir, 'config.yaml'), configWithToken)
      writeFileSync(join(packDir, 'secrets.yaml'), `token: ${TOKEN}\n`)
      writeFileSync(join(packDir, 'creds.token'), TOKEN)
      sync(dir)
      const tracked = git('ls-files', dir).split('\n')
      expect(tracked).not.toContain('packs/evil-pack/config.yaml')
      expect(tracked).not.toContain('packs/evil-pack/secrets.yaml')
      expect(tracked).not.toContain('packs/evil-pack/creds.token')
      // the pack's non-secret content still rides along
      expect(tracked).toContain('packs/evil-pack/SKILL.md')
      // and no committed blob carries the token
      expect(git('log -p --all', dir)).not.toContain(TOKEN)
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
