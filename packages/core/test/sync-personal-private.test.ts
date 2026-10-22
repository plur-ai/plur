// A personal sync remote (the default) is the user's own mirror: private
// memories go there, because it is their backup across their own machines
// (owner decision 2026-10-19, SYN-4). It is still a remote, so a scope:local
// memory, and every side record (episode, candidate, contradiction record) that
// names or quotes one, stays on this machine (SYN-6).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim()
}

const ENGRAMS = [
  'engrams:',
  '  - id: ENG-CHOSEN',
  '    scope: global',
  '    visibility: private',
  '    statement: chosen private dentist note',
  '  - id: ENG-TEAMCHOSEN',
  '    scope: "group:acme/eng"',
  '    visibility: private',
  '    statement: chosen private opinion of the reorg',
  '  - id: ENG-DEFAULT',
  '    scope: global',
  '    visibility: private',
  '    statement: default visibility editor preference',
  '  - id: ENG-PUBLIC',
  '    scope: global',
  '    visibility: public',
  '    statement: public cross-project note',
  '  - id: ENG-LOCAL',
  '    scope: local',
  '    visibility: public',
  '    statement: machine-local database port',
  '',
].join('\n')

const EPISODES = [
  '- id: EP-ABOUT-CHOSEN',
  '  summary: "Failure report for ENG-CHOSEN: chosen private dentist note was wrong"',
  '- id: EP-ABOUT-LOCAL',
  '  summary: applied ENG-LOCAL (machine-local database port)',
  '- id: EP-ABOUT-DEFAULT',
  '  summary: applied ENG-DEFAULT',
  '- id: EP-PLAIN',
  '  summary: plain session summary with no memory references',
  '',
].join('\n')

const TENSIONS = [
  '- id: T-1',
  '  engram_a: ENG-DEFAULT',
  '  engram_b: ENG-PUBLIC',
  '  statement_a: default visibility editor preference',
  '  statement_b: public cross-project note',
  '- id: T-2',
  '  engram_a: ENG-LOCAL',
  '  engram_b: ENG-PUBLIC',
  '  statement_a: machine-local database port',
  '  statement_b: public cross-project note',
  '- id: T-3',
  '  engram_a: ENG-TEAMCHOSEN',
  '  engram_b: ENG-PUBLIC',
  '  statement_a: chosen private opinion of the reorg',
  '  statement_b: public cross-project note',
  '',
].join('\n')

const CANDIDATES = [
  '- engram_a: ENG-CHOSEN',
  '  engram_b: ENG-PUBLIC',
  '  statement_a: chosen private dentist note',
  '- engram_a: ENG-DEFAULT',
  '  engram_b: ENG-PUBLIC',
  '',
].join('\n')

const WITHHELD_TEXT = /machine-local database port|ENG-LOCAL/

describe('personal sync remote mirrors private memories and keeps machine-local ones home', () => {
  isolateGitConfig()
  let dir: string
  let bareRemote: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-sync-personal-'))
    writeFileSync(join(dir, 'engrams.yaml'), ENGRAMS)
    writeFileSync(join(dir, 'episodes.yaml'), EPISODES)
    writeFileSync(join(dir, 'tensions.yaml'), TENSIONS)
    writeFileSync(join(dir, 'candidates.yaml'), CANDIDATES)
    bareRemote = mkdtempSync(join(tmpdir(), 'plur-remote-'))
    execSync('git init --bare', { cwd: bareRemote })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(bareRemote, { recursive: true, force: true })
  })

  it('engrams.yaml: private memories mirror, a scope:local memory is withheld', () => {
    sync(dir, bareRemote)
    const committed = git('show HEAD:engrams.yaml', dir)
    expect(committed).toContain('ENG-CHOSEN')
    expect(committed).toContain('ENG-TEAMCHOSEN')
    expect(committed).toContain('ENG-DEFAULT')
    expect(committed).toContain('ENG-PUBLIC')
    expect(committed).not.toContain('ENG-LOCAL')
    // The working tree keeps everything.
    const onDisk = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
    expect(onDisk).toContain('ENG-CHOSEN')
    expect(onDisk).toContain('ENG-LOCAL')
  })

  it('side records naming a machine-local memory are stripped from every file; records about mirrored memories still go', () => {
    sync(dir, bareRemote)
    for (const file of ['episodes.yaml', 'tensions.yaml', 'candidates.yaml']) {
      expect(git(`show HEAD:${file}`, dir), file).not.toMatch(WITHHELD_TEXT)
    }
    const episodes = yaml.load(git('show HEAD:episodes.yaml', dir)) as Array<{ id: string }>
    expect(episodes.map(e => e.id)).toEqual(['EP-ABOUT-CHOSEN', 'EP-ABOUT-DEFAULT', 'EP-PLAIN'])
    const tensions = yaml.load(git('show HEAD:tensions.yaml', dir)) as Array<{ id: string }>
    expect(tensions.map(t => t.id)).toEqual(['T-1', 'T-3'])
    expect(git('show HEAD:candidates.yaml', dir)).toContain('ENG-CHOSEN')
    expect(git('show HEAD:candidates.yaml', dir)).toContain('ENG-DEFAULT')
    // The working tree keeps every side record.
    expect(readFileSync(join(dir, 'episodes.yaml'), 'utf8')).toContain('EP-ABOUT-LOCAL')
  })

  it('a clone of the personal remote carries no withheld text in any file', () => {
    sync(dir, bareRemote)
    const clone = mkdtempSync(join(tmpdir(), 'plur-clone-'))
    try {
      execSync(`git clone ${bareRemote} .`, { cwd: clone, stdio: 'pipe' })
      for (const file of git('ls-files', clone).split('\n').filter(Boolean)) {
        expect(readFileSync(join(clone, file), 'utf8'), file).not.toMatch(WITHHELD_TEXT)
      }
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
  })

  it('no new commit when only a withheld memory or its side record changes (#396 property)', async () => {
    sync(dir, bareRemote)
    const before = parseInt(git('rev-list --count HEAD', dir), 10)
    writeFileSync(join(dir, 'engrams.yaml'), ENGRAMS.replace('machine-local database port', 'machine-local database port EDITED'))
    writeFileSync(join(dir, 'episodes.yaml'), EPISODES.replace('applied ENG-LOCAL', 'applied ENG-LOCAL again'))
    const result = await sync(dir)
    expect(result.files_changed).toBe(0)
    expect(parseInt(git('rev-list --count HEAD', dir), 10)).toBe(before)
  })

  it('the warning says machine-local memories stayed local and private ones are pushed', async () => {
    const result = await sync(dir, bareRemote)
    expect(result.warning).toMatch(/1 scope:local engram\(s\) are NOT pushed/)
    expect(result.warning).toMatch(/3 private-visibility engram\(s\) ARE pushed — use a private git remote/)
  })
})
