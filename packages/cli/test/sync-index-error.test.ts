/**
 * `plur sync` surfaces background index failures — closes #272 (iter-1 audit
 * gap M-11, Critic F-CRIT-006).
 *
 * The command awaits waitForIndex(), but the background chain's .catch has
 * already absorbed any rejection — so a failed index/reembed pass printed
 * "Sync: ok" with no indication. The command now reads plur.lastIndexError()
 * after the index quiesces and surfaces it in both text and JSON output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IndexSyncError } from '@plur-ai/core'

const mockPlur = {
  sync: vi.fn(),
  waitForIndex: vi.fn(async () => undefined),
  lastIndexError: vi.fn((): IndexSyncError | null => null),
}

vi.mock('../src/plur.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/plur.js')>()
  return { ...mod, createPlur: () => mockPlur as never }
})

import { run } from '../src/commands/sync.js'

describe('plur sync index-error surfacing (#272)', () => {
  let writes: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writes = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as never)
    mockPlur.sync.mockReturnValue({ action: 'up-to-date', message: '', remote: null, files_changed: 0 })
    mockPlur.lastIndexError.mockReturnValue(null)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  it('prints a warning in text mode when the background index pass failed', async () => {
    mockPlur.lastIndexError.mockReturnValue({
      op: 'sync-from-yaml',
      message: 'disk on fire',
      at: '2026-07-02T00:00:00.000Z',
    })
    await run([], { json: false })
    const out = writes.join('')
    expect(out).toContain('Sync: up-to-date')
    expect(out).toContain('sync-from-yaml')
    expect(out).toContain('disk on fire')
    // Must wait for the index before reading the error state.
    expect(mockPlur.waitForIndex).toHaveBeenCalled()
  })

  it('includes index_error in JSON output', async () => {
    const err: IndexSyncError = {
      op: 'reindex',
      message: 'rebuild exploded',
      at: '2026-07-02T00:00:00.000Z',
    }
    mockPlur.lastIndexError.mockReturnValue(err)
    await run(['--full'], { json: true })
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.index_error).toEqual(err)
  })

  it('stays quiet when the index pass succeeded', async () => {
    await run([], { json: true })
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.index_error).toBeUndefined()
    expect(parsed.action).toBe('up-to-date')
  })
})
