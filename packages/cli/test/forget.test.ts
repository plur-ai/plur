import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
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

  it('retires an engram by ID and returns JSON', async () => {
    const id = await learn('something to forget')
    const output = JSON.parse(run(`forget ${id}`))
    expect(output.success).toBe(true)
    expect(output.retired.id).toBe(id)
  })

  it('accepts --reason flag', async () => {
    const id = await learn('something with reason')
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

  it('fully retires a multiply-learned engram — CLI is an explicit user-facing forget (#766 force semantics)', async () => {
    // Learn the same statement twice: hash-dedup returns the existing engram
    // with reference_count incremented — the #766 resurrection precondition.
    const id = await learn('convention learned twice for dedup')
    const id2 = await learn('convention learned twice for dedup')
    expect(id2).toBe(id)

    const output = JSON.parse(run(`forget ${id}`))
    expect(output.success).toBe(true)

    // Without { force: true } a reference_count > 1 engram only DECREMENTS and
    // stays active — a later learn() at a different scope re-matches it and
    // inherits the old scope. The CLI must fully retire, same as MCP plur_forget.
    const raw = readFileSync(join(dir, 'engrams.yaml'), 'utf-8')
    expect(raw).toMatch(/status: "?retired"?/)
    // And a second forget refuses — the engram is genuinely retired.
    expect(() => run(`forget ${id}`)).toThrow()
  })

  it('exits 1 with no argument', () => {
    expect(() => run('forget')).toThrow()
  })

  it('throws when engram ID not found', () => {
    expect(() => run('forget ENG-9999-0101-001')).toThrow()
  })
})
