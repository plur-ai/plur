import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * Hooks installed globally must no-op silently in projects without plur
 * configured (#247): no output changes, no side effects, no errors.
 */
describe('injection hooks no-op in non-plur projects (#247)', () => {
  let dir: string

  beforeEach(() => {
    // Serves as cwd, HOME, and PLUR_PATH parent — contains no plur config
    dir = mkdtempSync(join(tmpdir(), 'plur-noop-test-'))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function runHook(
    cmd: string,
    input: object,
  ): { stdout: string; stderr: string; status: number } {
    const result = spawnSync('node', [CLI, cmd], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        TMPDIR: join(dir, 'tmp'),
        PLUR_PATH: join(dir, '.plur'),
      },
      cwd: dir,
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? 1,
    }
  }

  function addPlurConfig(): void {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
  }

  it('hook-inject produces no output and exits cleanly', () => {
    const result = runHook('hook-inject', { prompt: 'hello world' })
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
  })

  it('hook-observe passes stdin through and writes no observations', () => {
    const input = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }
    const result = runHook('hook-observe', input)
    expect(result.stdout).toBe(JSON.stringify(input))
    expect(result.status).toBe(0)
    expect(existsSync(join(dir, '.plur'))).toBe(false)
  })

  it('hook-learn-check passes stdin through and writes no counter', () => {
    const input = { session_id: 's1', cwd: dir }
    const result = runHook('hook-learn-check', input)
    expect(result.stdout).toBe(JSON.stringify(input))
    expect(result.status).toBe(0)
    expect(existsSync(join(dir, 'tmp', 'plur-sessions'))).toBe(false)
  })

  it('hook-observe still records observations when project has plur config', () => {
    addPlurConfig()
    const input = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }
    const result = runHook('hook-observe', input)
    expect(result.stdout).toBe(JSON.stringify(input))
    expect(existsSync(join(dir, '.plur', 'observations'))).toBe(true)
  })

  it('hook-learn-check still counts stops when project has plur config', () => {
    addPlurConfig()
    const input = { session_id: 's1', cwd: dir }
    const result = runHook('hook-learn-check', input)
    expect(result.stdout).toBe(JSON.stringify(input))
    expect(existsSync(join(dir, 'tmp', 'plur-sessions'))).toBe(true)
  })
})
