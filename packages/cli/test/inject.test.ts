import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur inject', () => {
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

  it('returns injection result with count and tokens', () => {
    learn('always write unit tests for new features')
    learn('use descriptive variable names')
    const output = JSON.parse(run('inject "write unit tests for the new feature"'))
    expect(output).toMatchObject({
      directives: expect.any(String),
      constraints: expect.any(String),
      consider: expect.any(String),
      count: expect.any(Number),
      tokens_used: expect.any(Number),
    })
    expect(output.count).toBeGreaterThanOrEqual(0)
    expect(output.tokens_used).toBeGreaterThanOrEqual(0)
  })

  it('respects --budget flag', () => {
    learn('always write unit tests for new features')
    learn('use descriptive variable names')
    // With a large budget, can inject more than a small budget
    const full = JSON.parse(run('inject "write unit tests" --budget 10000'))
    const small = JSON.parse(run('inject "write unit tests" --budget 1'))
    // Full budget should inject at least as many (or more) as tiny budget
    expect(full.count).toBeGreaterThanOrEqual(small.count)
  })

  it('exits 1 with no task', () => {
    let threw = false
    try {
      execSync(`node ${CLI} inject --path ${dir} --json --fast`, {
        encoding: 'utf-8',
        timeout: 10000,
      })
    } catch (err: any) {
      threw = true
      expect(err.status).toBe(1)
    }
    expect(threw).toBe(true)
  })

  describe('default learning protocol', () => {
    it('includes the default protocol in directives by default', () => {
      const output = JSON.parse(run('inject "write unit tests"'))
      expect(output.directives).toContain('## Learning Protocol')
      expect(output.directives).toContain('🧠 I learned')
    })

    it('suppresses the protocol with --no-with-default-protocol', () => {
      const output = JSON.parse(run('inject "write unit tests" --no-with-default-protocol'))
      expect(output.directives).not.toContain('## Learning Protocol')
    })

    it('appends the protocol to existing directives instead of replacing them', () => {
      // architectural → cognitive_level 'evaluate' → lands in the directives bucket
      execSync(`node ${CLI} learn "the project deploys to the staging server via rsync" --type architectural --path ${dir} --json`, {
        encoding: 'utf-8',
        timeout: 10000,
      })
      const output = JSON.parse(run('inject "how do we deploy the project"'))
      // Injected engram is still present...
      expect(output.directives).toContain('deploys to the staging server')
      // ...with the protocol appended after it
      expect(output.directives).toContain('## Learning Protocol')
      expect(output.directives.indexOf('deploys to the staging server'))
        .toBeLessThan(output.directives.indexOf('## Learning Protocol'))
    })
  })
})
