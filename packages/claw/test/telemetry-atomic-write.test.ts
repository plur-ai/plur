// Atomic write tmp naming (#188): pid-only tmp suffixes collide when two
// writes to the same path interleave in async contexts — the second write
// clobbers the first process-local tmp file before its rename. Every atomic
// write must use a unique tmp path.
//
// Lives in its own file because it partially mocks node:fs to observe tmp
// paths; the main telemetry-counters suite uses the real filesystem.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const writtenPaths: string[] = []
const renames: Array<{ from: string; to: string }> = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (path: any, data: any, opts: any) => {
      writtenPaths.push(String(path))
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
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-atomic-'))
    opts = {
      env: { PLUR_TELEMETRY: 'on' },
      configPath: join(dir, 'telemetry.json'),
      countersPath: join(dir, 'counters.json'),
      installIdPath: join(dir, 'install-id'),
      pendingDir: join(dir, 'pending'),
      now: () => new Date('2026-05-02T18:00:00Z'),
    }
  })

  it('never reuses a tmp path across writes to the same file', () => {
    recordEvent('learn', opts)
    recordEvent('recall', opts)
    resetCounters(opts)

    const tmpPaths = writtenPaths.filter((p) => p.includes('.tmp.'))
    // 3 counters.json writes + 1 install-id write
    expect(tmpPaths.length).toBeGreaterThanOrEqual(4)
    expect(new Set(tmpPaths).size).toBe(tmpPaths.length)
  })

  it('keeps the `<path>.tmp.` prefix convention for tmp files', () => {
    recordEvent('learn', opts)

    const counterTmps = writtenPaths.filter((p) => p.startsWith(`${join(dir, 'counters.json')}.tmp.`))
    expect(counterTmps.length).toBe(1)
    const installTmps = writtenPaths.filter((p) => p.startsWith(`${join(dir, 'install-id')}.tmp.`))
    expect(installTmps.length).toBe(1)
  })

  it('renames each tmp file onto its final path', () => {
    recordEvent('learn', opts)
    recordEvent('recall', opts)

    for (const { from, to } of renames) {
      expect(writtenPaths).toContain(from)
      expect(from.startsWith(`${to}.tmp.`)).toBe(true)
    }
  })
})
