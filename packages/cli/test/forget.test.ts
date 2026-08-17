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

  it('retires an engram by ID and returns JSON', () => {
    const id = learn('something to forget')
    const output = JSON.parse(run(`forget ${id}`))
    expect(output.success).toBe(true)
    expect(output.retired.id).toBe(id)
  })

  it('accepts --reason flag', () => {
    const id = learn('something with reason')
    const output = JSON.parse(run(`forget ${id} --reason "no longer relevant"`))
    expect(output.success).toBe(true)
    expect(output.retired.id).toBe(id)
  })

  it('retires by search term when single match', () => {
    learn('unique penguin convention')
    const output = JSON.parse(run('forget "unique penguin"'))
    expect(output.success).toBe(true)
    expect(output.retired.statement).toContain('penguin')
  })

  it('exits 1 with no argument', () => {
    expect(() => run('forget')).toThrow()
  })

  it('throws when engram ID not found', () => {
    expect(() => run('forget ENG-9999-0101-001')).toThrow()
  })
})
