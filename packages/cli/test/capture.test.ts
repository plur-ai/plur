import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur capture', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('captures an episode with positional summary', () => {
    const output = JSON.parse(run('capture "deployed version 1.0"'))
    expect(output.id).toBeDefined()
    expect(output.summary).toBe('deployed version 1.0')
    expect(output.timestamp).toBeDefined()
  })

  it('captures with --agent flag', () => {
    const output = JSON.parse(run('capture "agent task done" --agent myagent'))
    expect(output.summary).toBe('agent task done')
    expect(output.id).toBeDefined()
  })

  it('captures with --session flag', () => {
    const output = JSON.parse(run('capture "session task" --session sess-123'))
    expect(output.summary).toBe('session task')
    expect(output.id).toBeDefined()
  })

  it('reads summary from stdin', () => {
    const output = JSON.parse(
      execSync(`echo "stdin episode" | node ${CLI} capture --path ${dir} --json`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()
    )
    expect(output.summary).toBe('stdin episode')
  })

  it('exits 1 with no summary and no stdin', () => {
    expect(() => run('capture')).toThrow()
  })
})
