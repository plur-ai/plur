/**
 * `plur rescope <id...> --to <scope>` (#676) — CLI surface for scope movement,
 * plus the `plur promote <id> --to <scope>` spelling that delegates to it
 * (promote WITHOUT --to keeps its historical candidate-activation meaning).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur rescope', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-rescope-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 15000,
    }).trim()
  }

  function learn(statement: string, scope: string): string {
    const output = run(`learn "${statement}" --scope ${scope}`)
    return JSON.parse(output).id as string
  }

  it('moves an engram to another scope and preserves its id', () => {
    const id = learn('cli rescope statement', 'project:alpha')
    const output = JSON.parse(run(`rescope ${id} --to global`))
    expect(output.success).toBe(true)
    expect(output.results[0]).toMatchObject({ id, status: 'rescoped', to_scope: 'global', new_id: id })

    const listed = JSON.parse(run('list'))
    const row = (listed.engrams ?? listed).find((e: any) => e.id === id)
    expect(row.scope).toBe('global')
  })

  it('--dry-run previews without changing anything', () => {
    const id = learn('cli dry run statement', 'project:alpha')
    const output = JSON.parse(run(`rescope ${id} --to global --dry-run`))
    expect(output.success).toBe(true)
    expect(output.dry_run).toBe(true)
    expect(output.results[0]).toMatchObject({ status: 'rescoped', dry_run: true })

    const listed = JSON.parse(run('list'))
    const row = (listed.engrams ?? listed).find((e: any) => e.id === id)
    expect(row.scope).toBe('project:alpha')
  })

  it('accepts multiple ids in one call', () => {
    const a = learn('cli batch one', 'project:alpha')
    const b = learn('cli batch two', 'project:alpha')
    const output = JSON.parse(run(`rescope ${a} ${b} --to global`))
    expect(output.success).toBe(true)
    expect(output.results.map((r: any) => r.status)).toEqual(['rescoped', 'rescoped'])
  })

  it('exits 1 without --to or without ids', () => {
    expect(() => run('rescope ENG-2026-0101-001')).toThrow()
    expect(() => run('rescope --to global')).toThrow()
  })

  it('exits 1 with a structured error for an unconfigured shared target scope', () => {
    const id = learn('cli typo scope statement', 'local')
    let failed = false
    try {
      run(`rescope ${id} --to group:plur-ai/engineering`)
    } catch (err: any) {
      failed = true
      // With --json the structured error lands on stdout before exit(1).
      const out = String(err.stdout ?? '')
      expect(out).toMatch(/no configured store matches/)
    }
    expect(failed).toBe(true)
  })

  it('`plur promote <id> --to <scope>` delegates to rescope', () => {
    const id = learn('cli promote-to statement', 'project:alpha')
    const output = JSON.parse(run(`promote ${id} --to global`))
    expect(output.success).toBe(true)
    expect(output.results[0]).toMatchObject({ id, status: 'rescoped', to_scope: 'global' })
  })
})
