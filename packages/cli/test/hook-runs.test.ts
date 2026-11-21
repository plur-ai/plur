import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordHookRun, readHookRuns, recordHookNote, readHookNotes } from '../src/lib/hook-runs.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-hook-runs-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
it('preserves other tool timestamps and returns only valid records', () => {
  recordHookRun('codex', root)
  const first = readHookRuns(root).codex
  expect(Number.isFinite(Date.parse(first!))).toBe(true)
  recordHookRun('cursor', root)
  expect(readHookRuns(root).codex).toBe(first)
  expect(Number.isFinite(Date.parse(readHookRuns(root).cursor!))).toBe(true)
})
it('a write failure is reported on stderr and never throws', () => {
  const notDirectory = join(root, 'file'); writeFileSync(notDirectory, 'fixture')
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(() => recordHookRun('codex', notDirectory)).not.toThrow()
  expect(error).toHaveBeenCalled()
})
it('hook notes (H13, H14) sit beside the trust timestamps and survive a run record', () => {
  recordHookRun('claude', root)
  expect(recordHookNote('claude', 'event', { event: 'skill', reason: 'cache-cold', mode: 'keyword', extra: undefined }, root)).toBe(true)
  recordHookRun('codex', root)
  const note = readHookNotes(root).claude!.event
  expect(note).toMatchObject({ event: 'skill', reason: 'cache-cold', mode: 'keyword' })
  expect('extra' in note).toBe(false)
  expect(Object.keys(readHookRuns(root)).sort()).toEqual(['claude', 'codex'])
  const notDirectory = join(root, 'file'); writeFileSync(notDirectory, 'fixture')
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(recordHookNote('claude', 'event', { event: 'skill' }, notDirectory)).toBe(false)
  expect(error).not.toHaveBeenCalled()
})
