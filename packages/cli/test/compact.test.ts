import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur compact', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  function learn(statement: string): string {
    const output = execSync(`node ${CLI} learn "${statement}" --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
    return JSON.parse(output).id as string
  }

  it('removes retired engrams and reports removed/remaining', () => {
    const id = learn('engram to be compacted away')
    learn('engram that stays active')
    // forget retires the first engram (status:retired) but leaves the row on disk
    execSync(`node ${CLI} forget ${id} --path ${dir} --json`, { encoding: 'utf-8', timeout: 10000 })

    const output = JSON.parse(run('compact'))
    expect(output.removed).toBe(1)
    expect(output.remaining).toBe(1)

    // idempotent: a second compact finds nothing left to remove
    const again = JSON.parse(run('compact'))
    expect(again.removed).toBe(0)
    expect(again.remaining).toBe(1)
  })

  it('reports zero removed on a store with no retired engrams', () => {
    learn('only active engram here')
    const output = JSON.parse(run('compact'))
    expect(output.removed).toBe(0)
    expect(output.remaining).toBe(1)
  })

  it('handles an empty store without error', () => {
    const output = JSON.parse(run('compact'))
    expect(output.removed).toBe(0)
    expect(output.remaining).toBe(0)
  })

  it('prints a human-readable summary in text mode', async () => {
    const id = learn('doomed engram')
    execSync(`node ${CLI} forget ${id} --path ${dir} --json`, { encoding: 'utf-8', timeout: 10000 })

    // Text mode requires a TTY or an explicit json:false — run in-process.
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as never)
    try {
      const { run: runCompact } = await import('../src/commands/compact.js')
      await runCompact([], { path: dir, json: false })
    } finally {
      spy.mockRestore()
    }
    const out = writes.join('')
    expect(out).toContain('removed 1 retired engram')
    expect(out).toContain('0 remaining')
  })
})
