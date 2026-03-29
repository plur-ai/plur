import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur forget', () => {
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

  it('retires an engram and returns JSON', () => {
    const id = learn('something to forget')
    const output = JSON.parse(run(`forget ${id}`))
    expect(output.id).toBe(id)
    expect(output.status).toBe('retired')
  })

  it('accepts --reason flag', () => {
    const id = learn('something with reason')
    const output = JSON.parse(run(`forget ${id} --reason "no longer relevant"`))
    expect(output.id).toBe(id)
    expect(output.status).toBe('retired')
    expect(output.reason).toBe('no longer relevant')
  })

  it('exits 1 with no id', () => {
    expect(() => run('forget')).toThrow()
  })

  it('throws when engram not found', () => {
    expect(() => run('forget ENG-9999')).toThrow()
  })
})
