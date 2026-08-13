/**
 * `plur sync --quiet` (#730) — status lines are suppressed, but a background
 * index failure is an outcome-differs warning and must survive --quiet
 * (suppressing it would regress #272's whole point: a broken index silently
 * reporting success).
 *
 * Same createPlur mock harness as sync-index-error.test.ts.
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

describe('plur sync --quiet (#730)', () => {
  let writes: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writes = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as never)
    mockPlur.sync.mockReturnValue({ action: 'up-to-date', message: 'all good', remote: null, files_changed: 2 })
    mockPlur.lastIndexError.mockReturnValue(null)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  it('suppresses the status lines under --quiet', async () => {
    await run([], { json: false, quiet: true })
    expect(writes.join('')).toBe('')
  })

  it('prints the status lines without --quiet', async () => {
    await run([], { json: false })
    const text = writes.join('')
    expect(text).toContain('Sync: up-to-date')
    expect(text).toContain('all good')
    expect(text).toContain('Files changed: 2')
  })

  it('still prints the index-failure warning under --quiet', async () => {
    mockPlur.lastIndexError.mockReturnValue({
      op: 'sync-from-yaml',
      message: 'disk on fire',
      at: '2026-07-02T00:00:00.000Z',
    })
    await run([], { json: false, quiet: true })
    const text = writes.join('')
    expect(text).not.toContain('Sync: up-to-date')
    expect(text).toContain('Warning: index sync-from-yaml failed — disk on fire')
  })

  it('--quiet does not touch JSON output', async () => {
    await run([], { json: true, quiet: true })
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.action).toBe('up-to-date')
  })
})
