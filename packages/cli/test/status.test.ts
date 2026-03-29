import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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

  it('reflects episode count after capture', () => {
    execSync(`node ${CLI} capture "test episode" --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    })
    const output = JSON.parse(run('status'))
    expect(output.episode_count).toBe(1)
  })
})
