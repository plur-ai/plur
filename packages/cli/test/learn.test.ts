import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur learn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('creates an engram and returns JSON', () => {
    const output = JSON.parse(run('learn "test statement"'))
    expect(output.id).toMatch(/^ENG-/)
    expect(output.statement).toBe('test statement')
    expect(output.scope).toBe('global')
    expect(output.type).toBe('behavioral')
  })

  it('accepts --scope and --type flags', () => {
    const output = JSON.parse(run('learn "typed statement" --scope agent:test --type procedural'))
    expect(output.scope).toBe('agent:test')
    expect(output.type).toBe('procedural')
  })

  it('accepts --domain flag', () => {
    const output = JSON.parse(run('learn "domain statement" --domain software.testing'))
    expect(output.domain).toBe('software.testing')
  })

  it('reads from stdin when no positional arg', () => {
    const output = JSON.parse(
      execSync(`echo "stdin statement" | node ${CLI} learn --path ${dir} --json`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()
    )
    expect(output.statement).toBe('stdin statement')
  })

  it('exits 1 with no statement and no stdin', () => {
    expect(() => run('learn')).toThrow()
  })
})
