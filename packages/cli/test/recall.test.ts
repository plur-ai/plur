import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur recall', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json --fast`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  function learn(statement: string): void {
    execSync(`node ${CLI} learn "${statement}" --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    })
  }

  it('finds matching engrams and returns count', () => {
    learn('always use TypeScript for new projects')
    learn('prefer tabs over spaces for indentation')
    const output = JSON.parse(run('recall "TypeScript"'))
    expect(output.count).toBeGreaterThan(0)
    expect(output.results).toBeInstanceOf(Array)
    expect(output.results[0]).toMatchObject({
      id: expect.stringMatching(/^ENG-/),
      statement: expect.any(String),
      scope: expect.any(String),
      type: expect.any(String),
      strength: expect.any(Number),
    })
    const statements = output.results.map((r: { statement: string }) => r.statement)
    expect(statements.some((s: string) => s.toLowerCase().includes('typescript'))).toBe(true)
  })

  it('respects --limit flag', () => {
    learn('always use TypeScript for new projects')
    learn('TypeScript is preferred over JavaScript')
    learn('use TypeScript strict mode')
    const output = JSON.parse(run('recall "TypeScript" --limit 2'))
    expect(output.results.length).toBeLessThanOrEqual(2)
  })

  it('exits 2 when no results found', () => {
    learn('always use TypeScript for new projects')
    let threw = false
    try {
      run('recall "zzznomatchxxx"')
    } catch (err: any) {
      threw = true
      expect(err.status).toBe(2)
    }
    expect(threw).toBe(true)
  })

  it('exits 1 with no query', () => {
    let threw = false
    try {
      execSync(`node ${CLI} recall --path ${dir} --json --fast`, {
        encoding: 'utf-8',
        timeout: 10000,
      })
    } catch (err: any) {
      threw = true
      expect(err.status).toBe(1)
    }
    expect(threw).toBe(true)
  })
})
