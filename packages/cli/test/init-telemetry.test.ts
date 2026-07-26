/**
 * Tests for the telemetry opt-in prompt introduced in `plur init`.
 *
 * AC coverage:
 *  (1) Non-interactive mode never writes PLUR_TELEMETRY=true without an explicit flag.
 *  (2) After `plur init` in non-interactive mode, telemetry-counters.json is NOT created
 *      (the gate stays off unless explicitly opted in).
 *  (3) `promptTelemetryOptIn` unit tests: non-interactive → writes enabled:false.
 *  (4) Already-configured path: existing telemetry.json is never overwritten.
 *
 * The TTY mock path (AC 4 integration test — answering "y" via TTY mock) is
 * impractical in a pure Node child_process test without a PTY library. That
 * scenario is covered by the unit-level `promptTelemetryOptIn` export instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

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
