// Opt-in telemetry gate.
//
// Resolution order (last writer wins on ties; only `on` activates the gate):
//   1. PLUR_TELEMETRY env var — `on` | `off` (any other value is treated as unset)
//   2. Persisted preference at ~/.plur/telemetry.json — { enabled: boolean }
//   3. Default: 'off' (non-interactive installs never opt in implicitly)
//
// This file is the gate only. No counters, no flush, no transport — those land
// in follow-up commits behind a state of `on`. See docs/telemetry-design.md.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type TelemetryState = 'on' | 'off'
export type TelemetrySource = 'env' | 'config' | 'default'

export type TelemetryResolution = {
  state: TelemetryState
  source: TelemetrySource
  configPath: string
}

function resolveConfigPath(): string {
  return join(homedir(), '.plur', 'telemetry.json')
}

function readEnv(env: NodeJS.ProcessEnv): TelemetryState | null {
  const raw = env.PLUR_TELEMETRY
  if (raw === 'on') return 'on'
  if (raw === 'off') return 'off'
  return null
}

function readConfig(path: string): TelemetryState | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.enabled === true) return 'on'
    if (parsed && typeof parsed === 'object' && parsed.enabled === false) return 'off'
    return null
  } catch {
    return null
  }
}

export function resolveTelemetry(opts: { env?: NodeJS.ProcessEnv; configPath?: string } = {}): TelemetryResolution {
  const env = opts.env ?? process.env
  const configPath = opts.configPath ?? resolveConfigPath()

  const fromEnv = readEnv(env)
  if (fromEnv !== null) return { state: fromEnv, source: 'env', configPath }

  const fromConfig = readConfig(configPath)
  if (fromConfig !== null) return { state: fromConfig, source: 'config', configPath }

  return { state: 'off', source: 'default', configPath }
}

export function isTelemetryEnabled(opts?: { env?: NodeJS.ProcessEnv; configPath?: string }): boolean {
  return resolveTelemetry(opts).state === 'on'
}
