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
      writeFileSync(join(packDir, 'agent-keystore.json'), `{"crypto":{"ciphertext":"${TOKEN}"}}`)
      // #428: the old 4-name denylist missed these — now excluded by the allowlist
      // (only SKILL.md/engrams.yaml/INTEGRITY/metadata.json are staged from a pack).
      writeFileSync(join(packDir, '.env'), `API_TOKEN=${TOKEN}\n`)
      writeFileSync(join(packDir, 'server.pem'), `-----BEGIN PRIVATE KEY-----\n${TOKEN}\n`)
      writeFileSync(join(packDir, 'id_rsa'), TOKEN)
      // a legit pack file the allowlist DOES keep
      writeFileSync(join(packDir, 'engrams.yaml'), '- id: ENG-PACK-1\n  statement: hi\n')
      sync(dir)
      const tracked = git('ls-files', dir).split('\n')
      expect(tracked).not.toContain('packs/evil-pack/config.yaml')
      expect(tracked).not.toContain('packs/evil-pack/secrets.yaml')
      expect(tracked).not.toContain('packs/evil-pack/creds.token')
      expect(tracked).not.toContain('packs/evil-pack/agent-keystore.json')
      expect(tracked).not.toContain('packs/evil-pack/.env')
      expect(tracked).not.toContain('packs/evil-pack/server.pem')
      expect(tracked).not.toContain('packs/evil-pack/id_rsa')
      // the pack's allowlisted content still rides along
      expect(tracked).toContain('packs/evil-pack/SKILL.md')
      expect(tracked).toContain('packs/evil-pack/engrams.yaml')
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

  describe('scope:local exclusion (issue #396)', () => {
    let bareRemote: string

    // Canonical engrams.yaml shape: { engrams: [...] }
    const CANONICAL = [
      'engrams:',
      '  - id: ENG-001',
      '    scope: "project:app"',
      '    visibility: private',
      '    statement: shared across my devices',
      '  - id: ENG-002',
      '    scope: local',
      '    visibility: private',
      '    statement: machine-specific note',
      '',
    ].join('\n')

    beforeEach(() => {
      writeFileSync(join(dir, 'engrams.yaml'), CANONICAL)
      bareRemote = mkdtempSync(join(tmpdir(), 'plur-remote-'))
      execSync('git init --bare', { cwd: bareRemote })
    })

    afterEach(() => {
      rmSync(bareRemote, { recursive: true, force: true })
    })

    it('strips scope:local engrams from the committed (remote) engrams.yaml', () => {
      sync(dir, bareRemote)
      // The committed blob (== what the remote received) must not contain the local engram.
      const committed = git('show HEAD:engrams.yaml', dir)
      expect(committed).toContain('ENG-001')
      expect(committed).not.toContain('ENG-002')
      expect(committed).not.toContain('machine-specific note')
    })

    it('keeps scope:local engrams in the local working tree (no data loss)', () => {
      sync(dir, bareRemote)
      const onDisk = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
      expect(onDisk).toContain('ENG-002')
      expect(onDisk).toContain('machine-specific note')
    })

    it('also strips local engrams committed during init (no remote)', () => {
      sync(dir) // init only, no remote
      const committed = git('show HEAD:engrams.yaml', dir)
      expect(committed).toContain('ENG-001')
      expect(committed).not.toContain('ENG-002')
    })

    it('does not create empty commits when only local engrams change (no infinite-dirty trap)', () => {
      sync(dir, bareRemote)
      const countAfterFirst = parseInt(git('rev-list --count HEAD', dir), 10)

      // Mutate ONLY a local-scoped engram — this must not produce a new commit.
      writeFileSync(
        join(dir, 'engrams.yaml'),
        CANONICAL.replace('machine-specific note', 'machine-specific note EDITED'),
      )
      const result = sync(dir)
      expect(result.files_changed).toBe(0)
      expect(result.action).toBe('up-to-date')

      const countAfterSecond = parseInt(git('rev-list --count HEAD', dir), 10)
      expect(countAfterSecond).toBe(countAfterFirst)
    })

    it('still commits when a non-local engram changes', () => {
      sync(dir, bareRemote)
      writeFileSync(
        join(dir, 'engrams.yaml'),
        CANONICAL.replace('shared across my devices', 'shared across my devices UPDATED'),
      )
      const result = sync(dir)
      expect(result.files_changed).toBeGreaterThan(0)
      const committed = git('show HEAD:engrams.yaml', dir)
      expect(committed).toContain('UPDATED')
      expect(committed).not.toContain('ENG-002')
    })
  })

  describe('private-engram warning (issue #396)', () => {
    let bareRemote: string

    beforeEach(() => {
      bareRemote = mkdtempSync(join(tmpdir(), 'plur-remote-'))
      execSync('git init --bare', { cwd: bareRemote })
    })

    afterEach(() => {
      rmSync(bareRemote, { recursive: true, force: true })
    })

    it('warns that the remote receives private engrams', () => {
      writeFileSync(
        join(dir, 'engrams.yaml'),
        'engrams:\n  - id: ENG-001\n    scope: "project:app"\n    visibility: private\n    statement: secret\n',
      )
      const result = sync(dir, bareRemote)
      expect(result.warning).toBeDefined()
      expect(result.warning).toMatch(/private/i)
    })

    it('omits the warning when there are no private engrams', () => {
      writeFileSync(
        join(dir, 'engrams.yaml'),
        'engrams:\n  - id: ENG-001\n    scope: "project:app"\n    visibility: public\n    statement: shareable\n',
      )
      const result = sync(dir, bareRemote)
      expect(result.warning).toBeUndefined()
    })
  })

  // #640 — scope-filtered push. A `shared` remote receives ONLY shared-family-
  // scope, non-private engrams; `personal` (the default) keeps the historical
  // mirror-everything-non-local behavior.
  describe('scope-filtered push for shared remotes (#640)', () => {
    let bareRemote: string

    const MIXED = [
      'engrams:',
      '  - id: ENG-TEAM',
      '    scope: "group:acme/engineering"',
      '    visibility: public',
      '    statement: team convention everyone should see',
      '  - id: ENG-TEAMPRIV',
      '    scope: "group:acme/engineering"',
      '    visibility: private',
      '    statement: drafted team note not yet shared',
      '  - id: ENG-GLOBAL',
      '    scope: global',
      '    statement: personal cross-project note',
      '  - id: ENG-USER',
      '    scope: "user:alice"',
      '    visibility: public',
      '    statement: personal-family scope even though public',
      '  - id: ENG-LOCAL',
      '    scope: local',
      '    statement: machine-specific note',
      '',
    ].join('\n')

    beforeEach(() => {
      writeFileSync(join(dir, 'engrams.yaml'), MIXED)
      bareRemote = mkdtempSync(join(tmpdir(), 'plur-remote-'))
      execSync('git init --bare', { cwd: bareRemote })
    })

    afterEach(() => {
      rmSync(bareRemote, { recursive: true, force: true })
    })

    it('shared: commits ONLY shared-scope, non-private engrams', () => {
      sync(dir, bareRemote, { remoteType: 'shared' })
      const committed = git('show HEAD:engrams.yaml', dir)
      expect(committed).toContain('ENG-TEAM')
      // Private shared-scope engram excluded (visibility gate)…
      expect(committed).not.toContain('ENG-TEAMPRIV')
      // …personal-family scopes excluded regardless of visibility (scope gate)…
      expect(committed).not.toContain('ENG-GLOBAL')
      expect(committed).not.toContain('ENG-USER')
      expect(committed).not.toContain('ENG-LOCAL')
    })

    it('shared: round-trip — a teammate clone receives only the shared set, the working tree keeps everything', () => {
      sync(dir, bareRemote, { remoteType: 'shared' })
      const clone = mkdtempSync(join(tmpdir(), 'plur-clone-'))
      try {
        execSync(`git clone ${bareRemote} .`, { cwd: clone, stdio: 'pipe' })
        const remoteCopy = readFileSync(join(clone, 'engrams.yaml'), 'utf8')
        expect(remoteCopy).toContain('ENG-TEAM')
        expect(remoteCopy).not.toContain('drafted team note')
        expect(remoteCopy).not.toContain('personal cross-project note')
      } finally {
        rmSync(clone, { recursive: true, force: true })
      }
      const onDisk = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
      expect(onDisk).toContain('ENG-GLOBAL')
      expect(onDisk).toContain('ENG-TEAMPRIV')
    })

    it('personal (default): behavior unchanged — private and personal-scope engrams still mirror', () => {
      sync(dir, bareRemote)
      const committed = git('show HEAD:engrams.yaml', dir)
      expect(committed).toContain('ENG-TEAM')
      expect(committed).toContain('ENG-TEAMPRIV')
      expect(committed).toContain('ENG-GLOBAL')
      expect(committed).toContain('ENG-USER')
      expect(committed).not.toContain('ENG-LOCAL')
    })

    it('shared: no new commit when only a stripped engram changes (deterministic blob, #396 property)', () => {
      sync(dir, bareRemote, { remoteType: 'shared' })
      const countAfterFirst = parseInt(git('rev-list --count HEAD', dir), 10)
      writeFileSync(
        join(dir, 'engrams.yaml'),
        MIXED.replace('personal cross-project note', 'personal cross-project note EDITED'),
      )
      const result = sync(dir, undefined, { remoteType: 'shared' })
      expect(result.files_changed).toBe(0)
      expect(result.action).toBe('up-to-date')
      expect(parseInt(git('rev-list --count HEAD', dir), 10)).toBe(countAfterFirst)
    })

    it('shared: warning reports the stripped count instead of the mirror-everything note', () => {
      const result = sync(dir, bareRemote, { remoteType: 'shared' })
      expect(result.warning).toBeDefined()
      expect(result.warning).toMatch(/stayed local/)
    })

    it('personal: warning now points at sync.remote_type shared for team remotes', () => {
      const result = sync(dir, bareRemote)
      expect(result.warning).toBeDefined()
      expect(result.warning).toMatch(/remote_type/)
    })
  })
})
