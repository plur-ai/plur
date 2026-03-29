import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur timeline', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  function capture(summary: string): void {
    execSync(`node ${CLI} capture "${summary}" --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    })
  }

  it('returns empty episodes on fresh store', () => {
    const output = JSON.parse(run('timeline'))
    expect(output.episodes).toBeInstanceOf(Array)
    expect(output.count).toBe(0)
  })

  it('returns episodes after capture', () => {
    capture('first episode')
    capture('second episode')
    const output = JSON.parse(run('timeline'))
    expect(output.count).toBeGreaterThanOrEqual(2)
    expect(output.episodes[0]).toMatchObject({
      id: expect.any(String),
      summary: expect.any(String),
      timestamp: expect.any(String),
    })
  })

  it('respects --limit flag', () => {
    capture('episode one')
    capture('episode two')
    capture('episode three')
    const output = JSON.parse(run('timeline --limit 2'))
    expect(output.episodes.length).toBeLessThanOrEqual(2)
  })

  it('accepts optional query positional', () => {
    capture('deployment completed successfully')
    capture('unit tests all passing')
    const output = JSON.parse(run('timeline "deployment"'))
    expect(output.episodes).toBeInstanceOf(Array)
    expect(output.count).toBeGreaterThanOrEqual(0)
  })
})
