/**
 * A queued turn that carries the workspace scope (Cursor, M1 of the #1583
 * audit) must never be read by an older capture worker (N4 of the re-audit).
 * An older worker reads only `<editor>-<session>.queue` and its renamed
 * batches `<editor>-<session>.queue.<pid>`; it ignores `workspaceScope` and
 * would re-decide the scope from one folder, which can widen it. Such a line
 * goes to its own file, which the new worker drains; a line without the field
 * still goes to the old file, which the new worker still reads.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let tmp: string
let saved: Record<string, string | undefined>
let mod: typeof import('../src/lib/auto-rate.js')

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'plur-queue-ws-')))
  saved = { TMPDIR: process.env.TMPDIR, PLUR_AUTO_CAPTURE: process.env.PLUR_AUTO_CAPTURE }
  process.env.TMPDIR = tmp
  process.env.PLUR_AUTO_CAPTURE = '1'
  vi.resetModules()
  mod = await import('../src/lib/auto-rate.js')
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(tmp, { recursive: true, force: true })
})

/** The files an older worker reads for this session: the queue and its renamed batches. */
function oldWorkerFiles(editor: string, session: string): string[] {
  const q = `${editor}-${session}.queue`
  return readdirSync(join(tmp, 'plur-auto-rate')).filter(f => f === q || f.startsWith(`${q}.`))
}

describe('a turn carrying workspaceScope is invisible to an older worker (N4)', () => {
  it('workspaceScope null or a string → not in the queue file an older worker reads', () => {
    expect(mod.enqueueTurn({ editor: 'cursor', sessionId: 'n4-a', reply: 'Done.', cwd: tmp, workspaceScope: null })).toBe(true)
    expect(mod.enqueueTurn({ editor: 'cursor', sessionId: 'n4-a', reply: 'Done again.', cwd: tmp, workspaceScope: 'project:alpha' })).toBe(true)
    expect(oldWorkerFiles('cursor', 'n4-a')).toEqual([])
    expect(mod.hasLeftoverBatches('cursor', 'n4-a') || readdirSync(join(tmp, 'plur-auto-rate')).some(f => f.startsWith('cursor-n4-a.'))).toBe(true)
  })

  it('a turn without workspaceScope still uses the old queue file (other editors, old lines)', () => {
    expect(mod.enqueueTurn({ editor: 'claude', sessionId: 'n4-b', reply: 'Done.', cwd: tmp })).toBe(true)
    const files = oldWorkerFiles('claude', 'n4-b')
    expect(files).toEqual(['claude-n4-b.queue'])
    expect(readFileSync(join(tmp, 'plur-auto-rate', files[0]), 'utf8')).not.toContain('workspaceScope')
  })
})
