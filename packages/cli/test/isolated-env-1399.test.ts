/**
 * #1399 — `isolatedHomeEnv` must not pass a developer shell's CODEX_HOME,
 * PLUR_PATH, PLUR_BACKEND, PLUR_POSTGRES_URL or PLUR_TELEMETRY through to a
 * spawned `plur init` / `plur doctor`: each one sends the child to real files
 * or changes what it does.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'path'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const LEAKY = ['CODEX_HOME', 'PLUR_PATH', 'PLUR_BACKEND', 'PLUR_POSTGRES_URL', 'PLUR_TELEMETRY'] as const

describe('isolatedHomeEnv (#1399)', () => {
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of LEAKY) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('roots CODEX_HOME and PLUR_PATH in the temp HOME and blanks the backend and telemetry switches', () => {
    for (const k of LEAKY) { saved[k] = process.env[k]; process.env[k] = `/real/${k}` }
    const home = '/tmp/plur-isolated-home'
    const env = isolatedHomeEnv(home)
    expect(env.CODEX_HOME).toBe(join(home, '.codex'))
    expect(env.PLUR_PATH).toBe(join(home, '.plur'))
    expect(env.PLUR_BACKEND).toBe('')
    expect(env.PLUR_POSTGRES_URL).toBe('')
    expect(env.PLUR_TELEMETRY).toBe('')
    for (const v of Object.values(env)) expect(String(v)).not.toMatch(/^\/real\//)
  })
})
