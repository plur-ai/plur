import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur scopes', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-scopes-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  function runExpectFail(args: string): { stdout: string; stderr: string; status: number } {
    const result = spawnSync('node', [CLI, ...args.split(' '), '--path', dir], {
      encoding: 'utf-8',
      timeout: 10000,
    })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status ?? 1 }
  }

  it('list returns empty discoveries when no remotes configured', () => {
    const output = JSON.parse(run('scopes'))
    expect(output.discoveries).toBeInstanceOf(Array)
    expect(output.discoveries).toHaveLength(0)
  })

  it('list (subcommand) returns same as bare scopes', () => {
    const output = JSON.parse(run('scopes list'))
    expect(output.discoveries).toBeInstanceOf(Array)
  })

  it('dismiss persists and survives reload via --reoffer round-trip', () => {
    // dismiss a scope (no remote needed — only updates config dismissed_scopes)
    const dismiss = JSON.parse(run('scopes dismiss group:plur/test'))
    expect(dismiss.ok).toBe(true)
    expect(dismiss.scope).toBe('group:plur/test')

    // reoffer clears it
    const reoffer = JSON.parse(run('scopes --reoffer'))
    expect(reoffer.ok).toBe(true)
    expect(reoffer.action).toBe('reoffer')
  }, 30000)

  it('register with no remote configured returns skipped', () => {
    const output = JSON.parse(run('scopes register group:plur/test'))
    expect(output.ok).toBe(false)
    expect(output.status).toBe('skipped')
  })

  it('register missing scope argument exits non-zero', () => {
    const result = runExpectFail('scopes register')
    expect(result.status).not.toBe(0)
  })

  it('dismiss missing scope argument exits non-zero', () => {
    const result = runExpectFail('scopes dismiss')
    expect(result.status).not.toBe(0)
  })
})
