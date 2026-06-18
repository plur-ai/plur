import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('hook-session-guard', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-guard-test-'))
    // Create a settings.json with plur MCP so isPlurConfigured() returns true
    const claudeDir = join(home, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        },
      }),
    )
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runGuard(input: object): { stdout: string; stderr: string; status: number } {
    const result = spawnSync('node', [CLI, 'hook-session-guard'], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp') },
      cwd: home,
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? 1,
    }
  }

  it('blocks tools when session not started', () => {
    // Ensure TMPDIR exists for guard counter files
    mkdirSync(join(home, 'tmp'), { recursive: true })

    const result = runGuard({ session_id: 'test-123', tool_name: 'Bash' })
    expect(result.stdout).toContain('permissionDecision')
    expect(result.stdout).toContain('deny')
  })

  it('allows exempt tools without session', () => {
    mkdirSync(join(home, 'tmp'), { recursive: true })

    const result = runGuard({ session_id: 'test-123', tool_name: 'ToolSearch' })
    expect(result.stdout).not.toContain('deny')
  })

  it('nudges once then fails open (#199, #283)', () => {
    mkdirSync(join(home, 'tmp'), { recursive: true })

    // First call nudges (deny). Bounding to a single nudge prevents the
    // deferred-tool retry spiral on the exempt session_start call.
    const first = runGuard({ session_id: 'deadlock-test', tool_name: 'Bash' })
    expect(first.stdout).toContain('deny')

    // Second call falls through with the fallback warning.
    const fallback = runGuard({ session_id: 'deadlock-test', tool_name: 'Bash' })
    expect(fallback.stdout).not.toContain('deny')
    expect(fallback.stderr).toContain('plur doctor')

    // Every subsequent call also allows through — no spiral possible.
    for (let i = 0; i < 4; i++) {
      const result = runGuard({ session_id: 'deadlock-test', tool_name: 'Bash' })
      expect(result.stdout).not.toContain('deny')
    }
  })
})
