import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSetup } from '../src/setup.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-setup-'))
}

describe('claw setup command', () => {
  let dir: string
  let cfgPath: string
  beforeEach(() => {
    dir = newDir()
    cfgPath = join(dir, 'openclaw.json')
  })

  it('reports fail + fallback when config file is missing', () => {
    const r = runSetup({ configPath: cfgPath })
    expect(r.path).toBe(cfgPath)
    const cfgStep = r.steps.find((s) => s.step === 'config_enabled')!
    expect(cfgStep.status).toBe('fail')
    expect(r.fallbackBlock).toContain('plur-claw')
    expect(r.fallbackBlock).toContain('"enabled": true')
  })

  it('enables plugin in empty object config', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    const cfgStep = r.steps.find((s) => s.step === 'config_enabled')!
    expect(cfgStep.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.entries['plur-claw'].config).toEqual({ auto_learn: true, auto_capture: true, injection_budget: 2000 })
    expect(written.plugins.slots.memory).toBe('plur-claw')
    expect(written.mcp.servers.plur).toBeDefined()
    expect(written.mcp.servers.plur.command).toBe('npx')
  })

  it('preserves existing plugin config fields when enabling', () => {
    const prior = {
      plugins: {
        entries: {
          'plur-claw': { config: { injection_budget: 4000 } },
          'other-plugin': { enabled: true },
        },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runSetup({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'config_enabled')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].config.injection_budget).toBe(4000)
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.entries['other-plugin']).toEqual({ enabled: true })
  })

  it('is idempotent when fully configured (reports skip)', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { auto_learn: true, auto_capture: true, injection_budget: 2000 } } },
        slots: { memory: 'plur-claw' },
      },
      mcp: { servers: { plur: { command: 'npx', args: ['-y', '@plur-ai/mcp'] } } },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runSetup({ configPath: cfgPath })
    const cfgStep = r.steps.find((s) => s.step === 'config_enabled')!
    expect(cfgStep.status).toBe('skip')
    expect(cfgStep.detail).toBe('already enabled')
  })

  it('reports fail + fallback on malformed JSON', () => {
    writeFileSync(cfgPath, '{not json', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'config_enabled')!.status).toBe('fail')
    expect(r.fallbackBlock).toBeDefined()
  })

  it('always marks reload_required and runtime_confirmed as pending', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'reload_required')!.status).toBe('pending')
    expect(r.steps.find((s) => s.step === 'runtime_confirmed')!.status).toBe('pending')
  })

  it('creates valid JSON output on write', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    runSetup({ configPath: cfgPath })
    expect(existsSync(cfgPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(parsed).toBeTypeOf('object')
  })
})
