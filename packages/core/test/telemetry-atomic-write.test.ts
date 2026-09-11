// Atomic write tmp naming (#188): pid-only tmp suffixes collide when two
// writes to the same path interleave in async contexts — the second write
// clobbers the first process-local tmp file before its rename. Every atomic
// write must use a unique tmp path.
//
// Lives in its own file because it partially mocks node:fs to observe tmp
// paths; the main telemetry-counters suite uses the real filesystem.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const writtenPaths: string[] = []
const renames: Array<{ from: string; to: string }> = []
const descriptors = new Map<number, string>()
const opens: Array<{ path: string; flags: unknown; mode: unknown }> = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (path: any, flags: any, mode: any) => {
      const fd = actual.openSync(path, flags, mode)
      descriptors.set(fd, String(path))
      opens.push({ path: String(path), flags, mode })
      return fd
    },
    closeSync: (fd: number) => {
      descriptors.delete(fd)
      return actual.closeSync(fd)
    },
    writeFileSync: (path: any, data: any, opts: any) => {
      writtenPaths.push(typeof path === 'number' ? descriptors.get(path)! : String(path))
      return actual.writeFileSync(path, data, opts)
    },
    renameSync: (from: any, to: any) => {
      renames.push({ from: String(from), to: String(to) })
      return actual.renameSync(from, to)
    },
  }
})

import { recordEvent, resetCounters, type CountersOpts } from '../src/telemetry-counters.js'

describe('atomic write tmp naming (#188)', () => {
  let dir: string
  let opts: CountersOpts

  beforeEach(() => {
    writtenPaths.length = 0
    renames.length = 0
    opens.length = 0
    descriptors.clear()
    dir = mkdtempSync(join(tmpdir(), 'plur-atomic-'))
    opts = {
      env: { PLUR_TELEMETRY: 'on' },
      configPath: join(dir, 'telemetry.json'),
      countersPath: join(dir, 'counters.json'),
      installIdPath: join(dir, 'install-id'),
      pendingDir: join(dir, 'pending'),
      now: () => new Date('2026-05-02T18:00:00Z'),
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('never reuses a tmp path across writes to the same file', () => {
    recordEvent('learn', opts)
    recordEvent('recall', opts)
    resetCounters(opts)

    const tmpPaths = writtenPaths.filter((p) => p.endsWith('.tmp'))
    // 3 counters.json writes + 1 install-id write
    expect(tmpPaths.length).toBeGreaterThanOrEqual(4)
    expect(new Set(tmpPaths).size).toBe(tmpPaths.length)
  })

  it('creates each temporary file exclusively and privately beside its destination', () => {
    recordEvent('learn', opts)

    const counterTmps = opens.filter(({ path }) => path.startsWith(`${join(dir, 'counters.json')}.`) && path.endsWith('.tmp'))
    expect(counterTmps.length).toBe(1)
    const installTmps = opens.filter(({ path }) => path.startsWith(`${join(dir, 'install-id')}.`) && path.endsWith('.tmp'))
    expect(installTmps.length).toBe(1)
    for (const entry of [...counterTmps, ...installTmps]) {
      expect(entry.flags).toBe('wx')
      expect(entry.mode).toBe(0o600)
    }
  })

  it('renames each tmp file onto its final path', () => {
    recordEvent('learn', opts)
    recordEvent('recall', opts)

    const replacements = renames.filter(({ from }) => from.endsWith('.tmp'))
    expect(replacements).toHaveLength(3)
    for (const { from, to } of replacements) {
      expect(writtenPaths).toContain(from)
      expect(from.startsWith(`${to}.`)).toBe(true)
    }
  })
})
