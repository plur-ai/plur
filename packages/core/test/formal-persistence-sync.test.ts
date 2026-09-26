/**
 * Formal-verification replay (spec/formal/PlurSpec/Persistence.lean, candidate 1):
 * git sync must pull while scope:local engrams exist, and must not lose them.
 *
 * HEAD = strip(W) by design (#396), so the working tree is permanently dirty
 * whenever any scope:local engram exists; `git pull` refuses a dirty tree, so
 * before the fix a machine holding one local engram could never integrate a
 * remote change again (and its pushes then failed non-fast-forward).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

const ids = (file: string): string[] =>
  ((yaml.load(readFileSync(file, 'utf8')) as any).engrams as any[]).map(e => e.id)

// Many real git invocations per case; generous timeout for a loaded machine.
describe('formal-persistence: sync pulls while scope:local engrams exist', { timeout: 120_000 }, () => {
  isolateGitConfig()
  let base: string, bare: string, A: string, B: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-fsync-'))
    bare = join(base, 'remote.git')
    A = join(base, 'A')
    B = join(base, 'B')
    execSync(`git init --bare "${bare}"`, { stdio: 'ignore' })
    execSync(`mkdir -p "${A}"`)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  function setup(withLocal: boolean): void {
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump({
      engrams: [
        { id: 'ENG-A1', scope: 'global', statement: 'a1' },
        ...(withLocal ? [{ id: 'ENG-L1', scope: 'local', statement: 'machine-only' }] : []),
      ],
    }, { lineWidth: 120, noRefs: true, quotingType: '"' }))
    sync(A, bare)
    execSync(`git clone "${bare}" "${B}"`, { stdio: 'ignore' })
    const doc = yaml.load(readFileSync(join(B, 'engrams.yaml'), 'utf8')) as any
    doc.engrams.push({ id: 'ENG-B1', scope: 'global', statement: 'b1' })
    writeFileSync(join(B, 'engrams.yaml'), yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' }))
    sync(B)
  }

  it('control: without a local engram the remote change is pulled', () => {
    setup(false)
    const r = sync(A)
    expect(r.message).toContain('pulled 1 remote commit')
    expect(ids(join(A, 'engrams.yaml'))).toEqual(['ENG-A1', 'ENG-B1'])
  })

  it('with a scope:local engram: pulls, keeps the local engram, never pushes it', () => {
    setup(true)
    const r = sync(A)
    expect(r.message).not.toContain('NOT pulled')
    expect(r.message).toContain('pulled 1 remote commit')
    const onDisk = ids(join(A, 'engrams.yaml'))
    expect(onDisk).toContain('ENG-B1')
    expect(onDisk).toContain('ENG-L1')
    expect(onDisk).toContain('ENG-A1')
    expect(git('show HEAD:engrams.yaml', A)).not.toContain('ENG-L1')
    // Still stripped-dirty only by the local engram, and nothing is behind.
    expect(git('rev-list --count HEAD..@{u}', A)).toBe('0')
  })

  it('with a scope:local engram and a local commit: rebases, pushes, keeps the local engram', () => {
    setup(true)
    // A local commit in a file the remote did not touch (a same-hunk edit would be
    // a genuine text conflict, which sync reports and does not resolve).
    writeFileSync(join(A, 'episodes.yaml'), '- id: EP-A\n  summary: local episode\n')
    const r = sync(A)
    expect(r.push_error).toBeUndefined()
    expect(r.message).not.toContain('NOT pulled')
    expect(r.message).toContain('pushed')
    const onDisk = readFileSync(join(A, 'engrams.yaml'), 'utf8')
    expect(onDisk).toContain('ENG-B1')
    expect(onDisk).toContain('ENG-L1')
    expect(execSync(`git show main:episodes.yaml`, { cwd: bare, encoding: 'utf8' })).toContain('EP-A')
    const remote = execSync(`git show main:engrams.yaml`, { cwd: bare, encoding: 'utf8' })
    expect(remote).toContain('ENG-B1')
    expect(remote).not.toContain('ENG-L1')
  })

  it('an unchanged remote file restores the working tree byte-for-byte', () => {
    setup(true)
    // B's change touches only episodes.yaml this time: reset B's engram edit.
    execSync(`git -C "${B}" reset --hard HEAD~1`, { stdio: 'ignore' })
    writeFileSync(join(B, 'episodes.yaml'), '- id: EP-1\n  summary: remote\n')
    execSync(`git -C "${B}" add -A && git -C "${B}" commit -qm ep && git -C "${B}" push -qf`, { stdio: 'ignore' })
    const before = readFileSync(join(A, 'engrams.yaml'), 'utf8')
    const r = sync(A)
    expect(r.message).toContain('pulled 1 remote commit')
    expect(readFileSync(join(A, 'engrams.yaml'), 'utf8')).toBe(before)
  })
})
