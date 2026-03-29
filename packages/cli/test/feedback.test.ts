import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur feedback', () => {
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

  it('records positive feedback and returns JSON', () => {
    const id = learn('always use TypeScript')
    const output = JSON.parse(run(`feedback ${id} positive`))
    expect(output.id).toBe(id)
    expect(output.signal).toBe('positive')
    expect(output.status).toBe('recorded')
  })

  it('records negative feedback', () => {
    const id = learn('always use JavaScript')
    const output = JSON.parse(run(`feedback ${id} negative`))
    expect(output.signal).toBe('negative')
    expect(output.status).toBe('recorded')
  })

  it('records neutral feedback', () => {
    const id = learn('some statement')
    const output = JSON.parse(run(`feedback ${id} neutral`))
    expect(output.signal).toBe('neutral')
    expect(output.status).toBe('recorded')
  })

  it('exits 1 with invalid signal', () => {
    const id = learn('test engram')
    expect(() => run(`feedback ${id} excellent`)).toThrow()
  })

  it('exits 1 with missing args', () => {
    expect(() => run('feedback')).toThrow()
  })

  it('throws when engram not found', () => {
    expect(() => run('feedback ENG-9999 positive')).toThrow()
  })
})
