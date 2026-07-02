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
    // Lock the anti-batching deny-reason guidance against regressions (#328):
    // load the deferred tool via ToolSearch as its own step, don't batch,
    // don't repeat, and the nudge fires only once.
    expect(first.stdout).toContain('ToolSearch')
    expect(first.stdout).toContain('Do not batch')
    expect(first.stdout).toContain('This reminder fires only once')

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

  it('memory injection is independent of the session-start sentinel (#328)', () => {
    // The fail-open guard relies on hook-inject (UserPromptSubmit) injecting
    // memory regardless of the guard sentinel: even if plur_session_start
    // never runs, the session still gets engrams. hook-inject keys its own
    // marker on ppid under $TMPDIR/plur-sessions/ and never reads the
    // guard's plur-session-{session_id} sentinel.
    mkdirSync(join(home, 'tmp'), { recursive: true })
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: join(home, 'tmp'),
      PLUR_PATH: join(home, '.plur'),
      // Degrade injectHybrid to BM25 — no model load in tests
      PLUR_DISABLE_EMBEDDINGS: '1',
    }

    // Seed an engram in the store — no session ever started.
    spawnSync('node', [CLI, 'learn', 'the project deploys to the staging server via rsync', '--json'], {
      encoding: 'utf-8',
      timeout: 15000,
      env,
      cwd: home,
    })

    // No guard sentinel exists for any session.
    expect(existsSync(join(home, 'tmp', 'plur-session-never-started'))).toBe(false)

    // hook-inject still starts a session and injects the engram.
    const result = spawnSync('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ prompt: 'how do we deploy the project' }),
      encoding: 'utf-8',
      timeout: 15000,
      env,
      cwd: home,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('additionalContext')
    expect(result.stdout).toContain('[PLUR Memory — session started')
    expect(result.stdout).toContain('deploys to the staging server')
  }, 30000)
})
