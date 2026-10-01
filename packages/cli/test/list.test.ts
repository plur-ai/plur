import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

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

  // --tags was declared as accepted (#986) but never parsed, so `list --tags x`
  // listed everything. There is no tag filter to apply, so it is refused.
  it('refuses --tags rather than silently listing everything', () => {
    learn('engram one')
    let status = 0
    let out = ''
    try { run('list --tags x') } catch (err: any) { status = err.status; out = `${err.stdout ?? ''}${err.stderr ?? ''}` }
    expect(status).toBe(1)
    expect(out).toContain('--tags')
  })

  // The inverse: --meta was parsed by `run` but missing from FLAGS, so the
  // argv check refused it before the parser ever saw it.
  it('accepts --meta', () => {
    learn('engram one')
    const output = JSON.parse(run('list --meta'))
    expect(output.count).toBe(0)
  })
})
