import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur status', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('returns status with required fields', () => {
    const output = JSON.parse(run('status'))
    expect(output.engram_count).toBeDefined()
    expect(output.episode_count).toBeDefined()
    expect(output.pack_count).toBeDefined()
    expect(output.storage_root).toBeDefined()
    expect(typeof output.engram_count).toBe('number')
    expect(typeof output.episode_count).toBe('number')
    expect(typeof output.pack_count).toBe('number')
  })

  it('storage_root points to the path dir', () => {
    const output = JSON.parse(run('status'))
    expect(output.storage_root).toContain(dir)
  })

  it('reflects engram count after learn', () => {
    execSync(`node ${CLI} learn "test engram" --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    })
    const output = JSON.parse(run('status'))
    expect(output.engram_count).toBe(1)
  })

  // #452 — injection-provenance event/label counts feed #202's volume gate.
  it('surfaces injection event/label counts in JSON output', () => {
    const output = JSON.parse(run('status'))
    expect(output.history_events).toEqual({
      co_injection: 0,
      injection_outcome: 0,
      outcome_positive: 0,
      outcome_negative: 0,
    })
  })

  it('surfaces event/label counts in text output', async () => {
    // Text mode requires a TTY or an explicit json:false — run in-process.
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as never)
    try {
      const { run: runStatus } = await import('../src/commands/status.js')
      await runStatus([], { path: dir, json: false })
    } finally {
      spy.mockRestore()
    }
    const out = writes.join('')
    expect(out).toContain('Events:')
    expect(out).toContain('co_injection 0')
    expect(out).toContain('outcomes 0 (+0/-0)')
  })

  it('reflects episode count after capture', () => {
    execSync(`node ${CLI} capture "test episode" --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    })
    const output = JSON.parse(run('status'))
    expect(output.episode_count).toBe(1)
  })

  // #1049 — provenance.identity line in `plur status`
  describe('provenance identity (#1049)', () => {
    it('omits Identity line when no identity is configured', async () => {
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as never)
      try {
        const { run: runStatus } = await import('../src/commands/status.js')
        await runStatus([], { path: dir, json: false })
      } finally {
        spy.mockRestore()
      }
      expect(writes.join('')).not.toContain('Identity:')
    })

    it('shows Identity line when provenance.identity is set', async () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'provenance:\n  identity: "agent:claude-sonnet-4-6"\n',
        'utf8',
      )
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as never)
      try {
        // Re-import with the new config in place — each call uses the path arg.
        const mod = await import('../src/commands/status.js')
        await mod.run([], { path: dir, json: false })
      } finally {
        spy.mockRestore()
      }
      const out = writes.join('')
      expect(out).toContain('Identity:')
      expect(out).toContain('agent:claude-sonnet-4-6')
      expect(out).toContain('mode: always')
    })

    it('shows mode: never when configured', async () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'provenance:\n  identity: "agent:observer"\n  mode: "never"\n',
        'utf8',
      )
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as never)
      try {
        const mod = await import('../src/commands/status.js')
        await mod.run([], { path: dir, json: false })
      } finally {
        spy.mockRestore()
      }
      const out = writes.join('')
      expect(out).toContain('mode: never')
    })
  })
})
