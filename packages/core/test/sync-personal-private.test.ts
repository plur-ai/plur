// A personal sync remote (the default) is the user's own mirror, but it is
// still a remote: a memory the user explicitly marked private, a scope:local
// memory, and every side record (episode, candidate, contradiction record) that
// names or quotes one of them stay on this machine.
//
// "Private" here means the user CHOSE it (visibility: 'private' passed at write
// time). The default visibility is also 'private' (#401) so that nothing reaches
// a shared remote or a pack without a deliberate choice; that default does not
// keep a memory off the user's own mirror.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { Plur } from '../src/index.js'
import { setEmbeddingsEnabled } from '../src/embeddings.js'
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
  '    structured_data:',
  '      _visibilitySource: explicit',
  '  - id: ENG-TEAMCHOSEN',
  '    scope: "group:acme/eng"',
  '    visibility: private',
  '    statement: chosen private opinion of the reorg',
  '    structured_data:',
  '      _visibilitySource: explicit',
  '  - id: ENG-DEFAULT',
  '    scope: global',
  '    visibility: private',
  '    statement: default visibility editor preference',
  '    structured_data:',
  '      _visibilitySource: default',
  '  - id: ENG-LEGACY',
  '    scope: global',
  '    visibility: private',
  '    statement: legacy note written before the marker existed',
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

const WITHHELD_TEXT = /chosen private|machine-local database port|ENG-CHOSEN|ENG-TEAMCHOSEN|ENG-LOCAL/

describe('personal sync remote keeps chosen-private and machine-local memories home', () => {
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

  it('engrams.yaml: a chosen-private memory is withheld, default-visibility and legacy memories still mirror', () => {
    sync(dir, bareRemote)
    const committed = git('show HEAD:engrams.yaml', dir)
    expect(committed).not.toContain('ENG-CHOSEN')
    expect(committed).not.toContain('ENG-TEAMCHOSEN')
    expect(committed).not.toContain('ENG-LOCAL')
    expect(committed).toContain('ENG-DEFAULT')
    expect(committed).toContain('ENG-LEGACY')
    expect(committed).toContain('ENG-PUBLIC')
    // The working tree keeps everything.
    const onDisk = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
    expect(onDisk).toContain('ENG-CHOSEN')
    expect(onDisk).toContain('ENG-LOCAL')
  })

  it('side records naming a withheld memory are stripped from every file; records about mirrored memories still go', () => {
    sync(dir, bareRemote)
    for (const file of ['episodes.yaml', 'tensions.yaml', 'candidates.yaml']) {
      expect(git(`show HEAD:${file}`, dir), file).not.toMatch(WITHHELD_TEXT)
    }
    const episodes = yaml.load(git('show HEAD:episodes.yaml', dir)) as Array<{ id: string }>
    expect(episodes.map(e => e.id)).toEqual(['EP-ABOUT-DEFAULT', 'EP-PLAIN'])
    const tensions = yaml.load(git('show HEAD:tensions.yaml', dir)) as Array<{ id: string }>
    expect(tensions.map(t => t.id)).toEqual(['T-1'])
    expect(git('show HEAD:candidates.yaml', dir)).toContain('ENG-DEFAULT')
    // The working tree keeps every side record.
    expect(readFileSync(join(dir, 'episodes.yaml'), 'utf8')).toContain('EP-ABOUT-CHOSEN')
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
    writeFileSync(join(dir, 'engrams.yaml'), ENGRAMS.replace('chosen private dentist note', 'chosen private dentist note EDITED'))
    writeFileSync(join(dir, 'episodes.yaml'), EPISODES.replace('applied ENG-LOCAL', 'applied ENG-LOCAL again'))
    const result = await sync(dir)
    expect(result.files_changed).toBe(0)
    expect(parseInt(git('rev-list --count HEAD', dir), 10)).toBe(before)
  })

  it('the warning says chosen-private memories stayed local', async () => {
    const result = await sync(dir, bareRemote)
    expect(result.warning).toMatch(/marked private/)
    expect(result.warning).toMatch(/NOT pushed/)
  })
})

describe('learn records whether visibility was chosen', () => {
  let dir: string
  beforeEach(() => {
    setEmbeddingsEnabled(false, 'test: embeddings off')
    dir = mkdtempSync(join(tmpdir(), 'plur-visibility-source-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("stamps 'explicit' when the caller names a visibility and 'default' when it does not", async () => {
    const plur = new Plur({ path: dir, autoDiscover: false })
    await plur.ready()
    const chosen = await plur.learn('my bank appointment is on Thursday', { scope: 'global', visibility: 'private' })
    const pub = await plur.learn('every PR needs a linked issue', { scope: 'global', visibility: 'public' })
    const dflt = await plur.learn('I prefer dark mode', { scope: 'global' })
    const stored = (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as { engrams: any[] }).engrams
    const source = (id: string) => stored.find(e => e.id === id)?.structured_data?._visibilitySource
    expect(source(chosen.id)).toBe('explicit')
    expect(source(pub.id)).toBe('explicit')
    expect(source(dflt.id)).toBe('default')
  })
})
