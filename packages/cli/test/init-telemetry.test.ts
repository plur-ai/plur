/**
 * Tests for the telemetry opt-in prompt introduced in `plur init`.
 *
 * AC coverage:
 *  (1) Non-interactive mode never writes PLUR_TELEMETRY=true without an explicit flag.
 *  (2) After `plur init` in non-interactive mode, telemetry-counters.json is NOT created
 *      (the gate stays off unless explicitly opted in).
 *  (3) `promptTelemetryOptIn` unit tests: non-interactive → writes enabled:false.
 *  (4) Already-configured path: existing telemetry.json is never overwritten.
 *  (5) Interactive answered path: "y" and "n" return the correct status AND
 *      persist the matching config. Covered by injecting fake TTY streams
 *      rather than a PTY library — see the `answerPrompt` helper below.
 *
 * (5) is a regression guard: `rl.close()` fires its 'close' handler
 * synchronously, so an implementation that closes before persisting lets the
 * close handler settle the promise first and report 'non-interactive' for an
 * answered prompt — telling a user who typed "y" that telemetry is disabled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { PassThrough } from 'stream'

// Unit import — tests the function directly without spawning a child process.
import { promptTelemetryOptIn } from '../src/commands/init.js'

const CLI = join(__dirname, '..', 'dist', 'index.js')

// ── Helper: run plur init in non-interactive mode (no TTY) ──────────────────

function runInitNonInteractive(home: string): string {
  return execSync(
    `node ${CLI} init --global --no-desktop --no-prompt`,
    {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: home,
    },
  )
}

describe('plur init — telemetry opt-in prompt', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-telemetry-init-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // ── AC (3): non-interactive mode never opts in ──────────────────────────

  it('non-interactive install writes enabled:false, never enabled:true', () => {
    const output = runInitNonInteractive(home)
    expect(output).toContain('PLUR installed')

    const telemetryPath = join(home, '.plur', 'telemetry.json')
    expect(existsSync(telemetryPath)).toBe(true)

    const config = JSON.parse(readFileSync(telemetryPath, 'utf-8'))
    // CRITICAL: non-interactive must never opt in without consent
    expect(config.enabled).toBe(false)
  })

  it('non-interactive output reports telemetry as disabled', () => {
    const output = runInitNonInteractive(home)
    expect(output).toMatch(/telemetry.*disabled/i)
  })

  // ── AC (3): after non-interactive init, telemetry counters are not created ─

  it('non-interactive install does not create telemetry-counters.json (gate stays off)', () => {
    runInitNonInteractive(home)
    // Counters file should not exist — the gate is off, no events fire
    const countersPath = join(home, '.plur', 'telemetry-counters.json')
    expect(existsSync(countersPath)).toBe(false)
  })

  // ── AC (4): already-configured path ─────────────────────────────────────

  it('does not overwrite an existing telemetry.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-unit-'))
    try {
      const configPath = join(dir, 'telemetry.json')
      writeFileSync(configPath, JSON.stringify({ enabled: true }))

      const result = await promptTelemetryOptIn({ configPath, noPrompt: true })
      expect(result).toBe('already-configured')

      // File must be unchanged
      const after = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(after.enabled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── Unit tests for promptTelemetryOptIn ─────────────────────────────────

  it('promptTelemetryOptIn: noPrompt flag → writes enabled:false, returns non-interactive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-unit-'))
    try {
      mkdirSync(dir, { recursive: true })
      const configPath = join(dir, 'telemetry.json')

      const result = await promptTelemetryOptIn({ configPath, noPrompt: true })
      expect(result).toBe('non-interactive')

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('promptTelemetryOptIn: CI env → writes enabled:false, returns non-interactive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-unit-'))
    try {
      const configPath = join(dir, 'telemetry.json')

      const result = await promptTelemetryOptIn({ configPath, env: { CI: 'true' } })
      expect(result).toBe('non-interactive')

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── AC (5): interactive answered path ───────────────────────────────────

  /**
   * Drives the real prompt with fake TTY streams. `PassThrough` with
   * `isTTY = true` satisfies the interactivity check and gives readline a
   * stream we can write the answer into — no PTY library needed.
   */
  async function answerPrompt(answer: string, configPath: string) {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const output = Object.assign(new PassThrough(), { isTTY: true })
    output.resume() // drain the prompt text so the stream never stalls

    const pending = promptTelemetryOptIn({ configPath, input, output, env: {} })
    input.write(answer)
    const result = await pending
    return {
      result,
      config: JSON.parse(readFileSync(configPath, 'utf-8')),
    }
  }

  it('promptTelemetryOptIn: answering "y" returns opted-in and persists enabled:true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-tty-'))
    try {
      const { result, config } = await answerPrompt('y\n', join(dir, 'telemetry.json'))
      // Regression: a close-before-write implementation returns 'non-interactive'
      // here, so the user is told telemetry is off while it is actually on.
      expect(result).toBe('opted-in')
      expect(config.enabled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('promptTelemetryOptIn: answering "n" returns opted-out and persists enabled:false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-tty-'))
    try {
      const { result, config } = await answerPrompt('n\n', join(dir, 'telemetry.json'))
      expect(result).toBe('opted-out')
      expect(config.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('promptTelemetryOptIn: answering "yes" is treated as consent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-tty-'))
    try {
      const { result, config } = await answerPrompt('yes\n', join(dir, 'telemetry.json'))
      expect(result).toBe('opted-in')
      expect(config.enabled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('promptTelemetryOptIn: an empty answer defaults to opted-out (the [y/N] default)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-tty-'))
    try {
      const { result, config } = await answerPrompt('\n', join(dir, 'telemetry.json'))
      expect(result).toBe('opted-out')
      expect(config.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── Explicit PLUR_TELEMETRY env var wins over the prompt ────────────────

  it('promptTelemetryOptIn: explicit PLUR_TELEMETRY skips the prompt and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-unit-'))
    try {
      const configPath = join(dir, 'telemetry.json')

      const result = await promptTelemetryOptIn({
        configPath,
        env: { PLUR_TELEMETRY: 'on' },
      })
      expect(result).toBe('already-configured')

      // No contradictory {enabled:false} file alongside PLUR_TELEMETRY=on
      expect(existsSync(configPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('promptTelemetryOptIn: non-interactive stdin (no TTY) → writes enabled:false', async () => {
    // process.stdin.isTTY is falsy in test runners — exercises the non-TTY path.
    const dir = mkdtempSync(join(tmpdir(), 'plur-telem-unit-'))
    try {
      const configPath = join(dir, 'telemetry.json')

      // No TTY in vitest → branch evaluates isInteractive=false
      const result = await promptTelemetryOptIn({ configPath })
      expect(['non-interactive', 'opted-out']).toContain(result)

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
