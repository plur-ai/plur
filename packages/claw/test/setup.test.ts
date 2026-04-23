import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctor, runRepair, runSetup } from '../src/setup.js'

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

  it('reports fail on enable + slot when config file is missing', () => {
    const r = runSetup({ configPath: cfgPath })
    expect(r.path).toBe(cfgPath)
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('fail')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('fail')
    expect(r.fallbackBlock).toContain('plur-claw')
    expect(r.fallbackBlock).toContain('"enabled": true')
  })

  it('enables plugin + selects slot in empty object config', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('ok')
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
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].config.injection_budget).toBe(4000)
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.entries['other-plugin']).toEqual({ enabled: true })
  })

  it('is idempotent when fully configured (reports skip on enable + slot)', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { auto_learn: true, auto_capture: true, injection_budget: 2000 } } },
        slots: { memory: 'plur-claw' },
      },
      mcp: { servers: { plur: { command: 'npx', args: ['-y', '@plur-ai/mcp'] } } },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runSetup({ configPath: cfgPath })
    const enableStep = r.steps.find((s) => s.step === 'plugin_enabled')!
    const slotStep = r.steps.find((s) => s.step === 'slot_selected')!
    expect(enableStep.status).toBe('skip')
    expect(enableStep.detail).toBe('already enabled')
    expect(slotStep.status).toBe('skip')
    expect(slotStep.detail).toBe('already set to plur-claw')
  })

  it('reports fail + fallback on malformed JSON', () => {
    writeFileSync(cfgPath, '{not json', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('fail')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('fail')
    expect(r.fallbackBlock).toBeDefined()
  })

  it('always marks reload_required and runtime_registered as pending', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'reload_required')!.status).toBe('pending')
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.status).toBe('pending')
  })

  it('appends plur-claw to a non-empty plugins.allow allowlist', () => {
    const prior = { plugins: { allow: ['other-plugin'] } }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.allow).toEqual(['other-plugin', 'plur-claw'])
  })

  it('does not create plugins.allow when it is absent (avoid gating other plugins)', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.allow).toBeUndefined()
  })

  it('does not create plugins.allow when it is present but empty', () => {
    const prior = { plugins: { allow: [] } }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.allow).toEqual([])
  })

  it('leaves plugins.allow alone when plur-claw is already allowlisted', () => {
    const prior = { plugins: { allow: ['other-plugin', 'plur-claw'] } }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.allow).toEqual(['other-plugin', 'plur-claw'])
  })

  it('creates valid JSON output on write', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    runSetup({ configPath: cfgPath })
    expect(existsSync(cfgPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(parsed).toBeTypeOf('object')
  })

  describe('plugin_discovered step', () => {
    const origHome = process.env.OPENCLAW_HOME
    beforeEach(() => {
      process.env.OPENCLAW_HOME = dir
    })
    afterAll(() => {
      if (origHome === undefined) delete process.env.OPENCLAW_HOME
      else process.env.OPENCLAW_HOME = origHome
    })

    it('reports fail with guidance when extensions dir is missing', () => {
      writeFileSync(cfgPath, '{}', 'utf8')
      const r = runSetup({ configPath: cfgPath })
      const step = r.steps.find((s) => s.step === 'plugin_discovered')!
      expect(step.status).toBe('fail')
      expect(step.detail).toContain('openclaw plugins install @plur-ai/claw')
    })

    it('reports ok when plur-claw is present under OPENCLAW_HOME/extensions', () => {
      mkdirSync(join(dir, 'extensions', 'plur-claw'), { recursive: true })
      writeFileSync(cfgPath, '{}', 'utf8')
      const r = runSetup({ configPath: cfgPath })
      const step = r.steps.find((s) => s.step === 'plugin_discovered')!
      expect(step.status).toBe('ok')
      expect(step.detail).toContain('plur-claw')
    })
  })

  it('emits steps in install → activation order', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath })
    const stepNames = r.steps.map((s) => s.step)
    expect(stepNames).toEqual([
      'package_present',
      'plugin_discovered',
      'plugin_enabled',
      'slot_selected',
      'reload_required',
      'runtime_registered',
    ])
  })
})

describe('claw doctor command', () => {
  let dir: string
  let cfgPath: string
  beforeEach(() => {
    dir = newDir()
    cfgPath = join(dir, 'openclaw.json')
  })

  it('reports fail on enable + slot when config file is missing, and does NOT create it', () => {
    const r = runDoctor({ configPath: cfgPath })
    const enableStep = r.steps.find((s) => s.step === 'plugin_enabled')!
    const slotStep = r.steps.find((s) => s.step === 'slot_selected')!
    expect(enableStep.status).toBe('fail')
    expect(enableStep.detail).toContain('config file not found')
    expect(enableStep.detail).toContain('npx @plur-ai/claw setup')
    expect(slotStep.status).toBe('fail')
    expect(existsSync(cfgPath)).toBe(false)
    expect(r.fallbackBlock).toBeUndefined()
  })

  it('reports ok on enable + slot when config is fully set up', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { auto_learn: true } } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('ok')
  })

  it('does not mutate an otherwise-valid config that is missing plur-claw', () => {
    const prior = { plugins: { entries: { 'other-plugin': { enabled: true } } } }
    const raw = JSON.stringify(prior)
    writeFileSync(cfgPath, raw, 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('fail')
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.detail).toContain('no entry for plur-claw')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('fail')
    expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
  })

  it('flags plugin as disabled when entry exists but enabled=false', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: false } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    const step = r.steps.find((s) => s.step === 'plugin_enabled')!
    expect(step.status).toBe('fail')
    expect(step.detail).toContain('enabled is not true')
  })

  it('flags slot as wrong when memory slot points to a different plugin', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'other-memory' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    const step = r.steps.find((s) => s.step === 'slot_selected')!
    expect(step.status).toBe('fail')
    expect(step.detail).toContain('other-memory')
    expect(step.detail).toContain('expected plur-claw')
  })

  it('reports fail on malformed JSON without overwriting', () => {
    const raw = '{not json'
    writeFileSync(cfgPath, raw, 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('fail')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('fail')
    expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
  })

  it('emits steps in install → activation order (same as setup)', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    expect(r.steps.map((s) => s.step)).toEqual([
      'package_present',
      'plugin_discovered',
      'plugin_enabled',
      'slot_selected',
      'reload_required',
      'runtime_registered',
    ])
  })

  it('always marks reload_required and runtime_registered as pending', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'reload_required')!.status).toBe('pending')
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.status).toBe('pending')
  })
})

describe('claw setup --repair mode', () => {
  let dir: string
  let cfgPath: string
  beforeEach(() => {
    dir = newDir()
    cfgPath = join(dir, 'openclaw.json')
  })

  it('no-ops when doctor reports enable + slot healthy', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { injection_budget: 4000 } } },
        slots: { memory: 'plur-claw' },
      },
    }
    const raw = JSON.stringify(prior)
    writeFileSync(cfgPath, raw, 'utf8')
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('ok')
    // Byte-identical: repair didn't write.
    expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
  })

  it('flips enabled=false to true without rewriting config.injection_budget', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: false, config: { injection_budget: 4000 } } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.entries['plur-claw'].config.injection_budget).toBe(4000)
  })

  it('adds missing plur-claw entry with default config when only entry is missing', () => {
    const prior = {
      plugins: {
        entries: { 'other-plugin': { enabled: true } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.entries['plur-claw'].config).toEqual({
      auto_learn: true,
      auto_capture: true,
      injection_budget: 2000,
    })
    expect(written.plugins.entries['other-plugin']).toEqual({ enabled: true })
  })

  it('sets memory slot when it is unset, without adding MCP config', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { injection_budget: 2000 } } },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.slots.memory).toBe('plur-claw')
    // MCP is not a doctor step; repair doesn't add it.
    expect(written.mcp).toBeUndefined()
  })

  it('does NOT overwrite a memory slot pointing to a different plugin', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'other-memory' },
      },
    }
    const raw = JSON.stringify(prior)
    writeFileSync(cfgPath, raw, 'utf8')
    const r = runRepair({ configPath: cfgPath })
    const slotStep = r.steps.find((s) => s.step === 'slot_selected')!
    expect(slotStep.status).toBe('fail')
    expect(slotStep.detail).toContain('other-memory')
    // Slot conflict preserved; file untouched.
    expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
  })

  it('creates a minimal config when file is missing', () => {
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.slots.memory).toBe('plur-claw')
    expect(written.mcp).toBeUndefined()
  })

  it('does not overwrite a malformed config file', () => {
    const raw = '{not json'
    writeFileSync(cfgPath, raw, 'utf8')
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('fail')
    expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
  })

  it('fixes both enable and slot in a single pass when both failed', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runRepair({ configPath: cfgPath })
    expect(r.steps.find((s) => s.step === 'plugin_enabled')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'slot_selected')!.status).toBe('ok')
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    expect(written.plugins.slots.memory).toBe('plur-claw')
  })

  it('preserves unrelated plugin entries when flipping enabled', () => {
    const prior = {
      plugins: {
        entries: {
          'plur-claw': { enabled: false, config: { injection_budget: 1500 } },
          'other-plugin': { enabled: true, config: { foo: 'bar' } },
        },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runRepair({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['other-plugin']).toEqual({ enabled: true, config: { foo: 'bar' } })
    expect(written.plugins.entries['plur-claw'].config.injection_budget).toBe(1500)
  })
})
