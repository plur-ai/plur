import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur list', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  function learn(statement: string, extra = ''): void {
    execSync(`node ${CLI} learn "${statement}" --path ${dir} --json ${extra}`, {
      encoding: 'utf-8',
      timeout: 10000,
    })
  }

  it('lists all engrams', () => {
    learn('always use TypeScript')
    learn('prefer tabs over spaces')
    const output = JSON.parse(run('list'))
    expect(output.count).toBe(2)
    expect(output.engrams).toHaveLength(2)
    expect(output.engrams[0]).toMatchObject({
      id: expect.stringMatching(/^ENG-/),
      statement: expect.any(String),
      scope: expect.any(String),
      type: expect.any(String),
      strength: expect.any(Number),
    })
  })

  it('filters by domain', () => {
    learn('always use TypeScript', '--domain software.languages')
    learn('prefer tabs over spaces', '--domain software.formatting')
    const output = JSON.parse(run('list --domain software.languages'))
    expect(output.count).toBe(1)
    expect(output.engrams[0].domain).toBe('software.languages')
  })

  it('filters by type', () => {
    learn('always use TypeScript', '--type behavioral')
    learn('init then run', '--type procedural')
    const output = JSON.parse(run('list --type procedural'))
    expect(output.count).toBe(1)
    expect(output.engrams[0].type).toBe('procedural')
  })

  it('respects --limit flag', () => {
    learn('engram one')
    learn('engram two')
    learn('engram three')
    const output = JSON.parse(run('list --limit 2'))
    expect(output.engrams.length).toBeLessThanOrEqual(2)
  })
})
