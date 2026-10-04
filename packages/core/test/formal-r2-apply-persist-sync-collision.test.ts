/**
 * Owner decision P1b (2026-09-27, `round2_rows.P1b_sync_collision`:
 * reid-held-local-record; findings/r2-persist.md item 3).
 *
 * `restoreWithheld` appended the held (withheld, never pushed) records to the
 * pulled engrams.yaml. When the pull brought a record with the same id (the
 * other machine minted it the same day), the store held that id twice and a
 * lookup by id returned the REMOTE record: the machine's own engram could no
 * longer be read, updated or forgotten by id. Now the held LOCAL record is
 * re-id'd — it was never pushed, so nothing outside this machine refers to it —
 * the rename is recorded in history, and both remain readable by their own ids.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { listHistoryMonths, readHistory } from '../src/history.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

const DUMP = { lineWidth: 120, noRefs: true, quotingType: '"' as const }
const rows = (file: string): Array<{ id: string; scope: string; statement: string }> =>
  (yaml.load(readFileSync(file, 'utf8')) as any).engrams

describe('P1b: a withheld local record whose id arrives from the remote is re-id\'d', { timeout: 120_000 }, () => {
  isolateGitConfig()
  let base: string, bare: string, A: string, B: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-p1b-'))
    bare = join(base, 'remote.git')
    A = join(base, 'A')
    B = join(base, 'B')
    execSync(`git init --bare "${bare}"`, { stdio: 'ignore' })
    mkdirSync(A)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  function setup(bStatement: string, bScope = 'global'): void {
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump({ engrams: [
      { id: 'ENG-2026-09-26-001', scope: 'global', statement: 'A shared' },
    ] }, DUMP))
    sync(A, bare)
    execSync(`git clone "${bare}" "${B}"`, { stdio: 'ignore' })
    // A learns a machine-only engram; B mints the same id the same day and pushes.
    const docA = yaml.load(readFileSync(join(A, 'engrams.yaml'), 'utf8')) as any
    docA.engrams.push({ id: 'ENG-2026-09-26-002', scope: 'local', statement: 'A local note' })
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump(docA, DUMP))
    const docB = yaml.load(readFileSync(join(B, 'engrams.yaml'), 'utf8')) as any
    docB.engrams.push({ id: 'ENG-2026-09-26-002', scope: bScope, statement: bStatement })
    writeFileSync(join(B, 'engrams.yaml'), yaml.dump(docB, DUMP))
    sync(B)
  }

  it('both records survive under distinct ids; the pulled one keeps the id', () => {
    setup('B team fact')
    const r = sync(A)
    expect(r.message).toContain('pulled')
    const got = rows(join(A, 'engrams.yaml'))
    expect(new Set(got.map(x => x.id)).size).toBe(got.length)
    expect(got.find(x => x.id === 'ENG-2026-09-26-002')?.statement).toBe('B team fact')
    const local = got.find(x => x.statement === 'A local note')
    expect(local).toBeDefined()
    expect(local!.id).not.toBe('ENG-2026-09-26-002')
    expect(local!.id).toMatch(/^ENG-2026-09-26-002-[A-Za-z0-9-]+$/)
    expect(local!.scope).toBe('local')
    // Still never pushed.
    expect(execSync('git show HEAD:engrams.yaml', { cwd: A, encoding: 'utf8' })).not.toContain('A local note')

    const ev = listHistoryMonths(A).flatMap(m => readHistory(A, m)).filter(x => x.event === 'engram_rekeyed')
    expect(ev).toHaveLength(1)
    expect(ev[0].engram_id).toBe(local!.id)
    expect(ev[0].data).toMatchObject({ from: 'ENG-2026-09-26-002', to: local!.id })
  })

  it('shared remote: a held tension naming the renamed local engram follows it to the new id', () => {
    const team = { id: 'ENG-2026-09-26-001', scope: 'group:acme/eng', visibility: 'public', statement: 'team fact' }
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump({ engrams: [team] }, DUMP))
    sync(A, bare, { remoteType: 'shared' })
    execSync(`git clone "${bare}" "${B}"`, { stdio: 'ignore' })
    // A: a personal engram (never pushed to a shared remote) and a tension about it.
    const docA = yaml.load(readFileSync(join(A, 'engrams.yaml'), 'utf8')) as any
    docA.engrams.push({ id: 'ENG-2026-09-26-002', scope: 'global', statement: 'A private note' })
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump(docA, DUMP))
    writeFileSync(join(A, 'tensions.yaml'), yaml.dump([
      { id: 'T-1', engram_a: 'ENG-2026-09-26-002', engram_b: 'ENG-2026-09-26-002', note: 'about ENG-2026-09-26-002' },
    ]))
    // B: a teammate mints the same id for a shared engram and pushes it.
    const docB = yaml.load(readFileSync(join(B, 'engrams.yaml'), 'utf8')) as any
    docB.engrams.push({ id: 'ENG-2026-09-26-002', scope: 'group:acme/eng', visibility: 'public', statement: 'B shared fact' })
    writeFileSync(join(B, 'engrams.yaml'), yaml.dump(docB, DUMP))
    execSync('git add -A && git commit -qm b && git push -q', { cwd: B })

    sync(A, undefined, { remoteType: 'shared' })
    const got = rows(join(A, 'engrams.yaml'))
    expect(got.find(x => x.id === 'ENG-2026-09-26-002')?.statement).toBe('B shared fact')
    const mine = got.find(x => x.statement === 'A private note')!
    expect(mine.id).not.toBe('ENG-2026-09-26-002')
    const tensions = yaml.load(readFileSync(join(A, 'tensions.yaml'), 'utf8')) as any[]
    expect(tensions).toHaveLength(1)
    expect(tensions[0]).toMatchObject({ engram_a: mine.id, engram_b: mine.id, note: `about ${mine.id}` })
  })
})
