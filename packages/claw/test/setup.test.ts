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
    // NB: the `allow` seeding this used to assert is the #51 gating bug — its
    // dedicated (inverted, it.fails) test lives below. On a truly empty config
    // there are no other plugins to gate, so we simply don't assert on `allow`
    // here rather than re-encode the buggy value.
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

  it('sets hooks.allowConversationAccess on fresh setup', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].hooks?.allowConversationAccess).toBe(true)
  })

  it('sets hooks.allowConversationAccess on existing entry without it', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { auto_learn: true } } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].hooks?.allowConversationAccess).toBe(true)
  })

  // #51 / D-4 (FIXED): setup previously force-set allowConversationAccess true by
  // spreading it AFTER the user's existing hooks, overriding a user who
  // deliberately turned conversation access OFF — a plugin re-granting itself a
  // privacy permission the user revoked. setup now only seeds it when absent and
  // preserves an explicit false.
  it('does not re-grant allowConversationAccess when the user set it false (#51)', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, hooks: { allowConversationAccess: false } } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].hooks.allowConversationAccess).toBe(false)
  })

  it('preserves existing hooks when adding allowConversationAccess', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, hooks: { someOtherHook: true } } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].hooks.allowConversationAccess).toBe(true)
    expect(written.plugins.entries['plur-claw'].hooks.someOtherHook).toBe(true)
  })

  it('is idempotent when fully configured (reports skip on enable + slot)', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { auto_learn: true, auto_capture: true, injection_budget: 2000 }, hooks: { allowConversationAccess: true } } },
        slots: { memory: 'plur-claw' },
        allow: ['plur-claw'],
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

  it('always marks reload_required as pending', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath, openclawHome: dir })
    expect(r.steps.find((s) => s.step === 'reload_required')!.status).toBe('pending')
  })

  it('marks runtime_registered pending when plugin entrypoint is absent', () => {
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath, openclawHome: dir })
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.status).toBe('pending')
  })

  it('marks runtime_registered ok when plugin entrypoint exists', () => {
    const distDir = join(dir, 'extensions', 'plur-claw', 'dist')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.js'), '', 'utf8')
    writeFileSync(cfgPath, '{}', 'utf8')
    const r = runSetup({ configPath: cfgPath, openclawHome: dir })
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.detail).toContain('verified')
  })

  it('appends plur-claw to a non-empty plugins.allow allowlist', () => {
    const prior = { plugins: { allow: ['other-plugin'] } }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.allow).toEqual(['other-plugin', 'plur-claw'])
  })

  // #51 / D-3 (FIXED): setup previously wrote `allow: ['plur-claw']` when `allow`
  // was absent. In OpenClaw an ABSENT allow means "allow ALL plugins"; writing a
  // one-element list silently GATES OFF every other plugin the user has (and
  // contradicts the doctor test below, "absent allow = no gating (ok)"). setup
  // now leaves an absent allow absent. Uses a config WITH other plugins so the
  // harm would actually be asserted.
  it('does not gate off other plugins on fresh install when allow is absent (#51)', () => {
    const prior = { plugins: { entries: { 'weather-plugin': { enabled: true }, 'git-plugin': { enabled: true } } } }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const allow = written.plugins.allow
    // Correct: either leave allow absent (allow-all), or include the plugins
    // that were already enabled. Never a bare ['plur-claw'] that excludes them.
    if (allow !== undefined) {
      expect(allow).toContain('weather-plugin')
      expect(allow).toContain('git-plugin')
    }
  })

  it('does not modify plugins.allow when it is present but empty (honour explicit clear)', () => {
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

  describe('stale entry pruning (item 1 — manifest mismatch fix)', () => {
    // #51 / D-2 (FIXED): setup previously DELETED a third-party plugin's entire
    // config entry (INCLUDING any API keys in its `config`) on the sole evidence
    // that its extensions/<id> directory was absent. That directory is transiently
    // absent during any install/upgrade, so this destroyed a user's credentials
    // for another vendor's plugin. setup no longer prunes foreign entries, so the
    // foreign entry and its credentials survive.
    it('preserves a third-party entry (and its credentials) when its extension dir is absent (#51)', () => {
      const prior = {
        plugins: {
          entries: {
            'plur-claw': { enabled: true },
            'weather-plugin': { enabled: true, config: { api_key: 'sk-SECRET-USER-KEY-123' } },
          },
          slots: { memory: 'plur-claw' },
          allow: ['plur-claw'],
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      // extensions/ dir exists (user has plugins set up) but weather-plugin/ does not
      mkdirSync(join(dir, 'extensions'), { recursive: true })
      runSetup({ configPath: cfgPath, openclawHome: dir })
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
      expect(written.plugins.entries['weather-plugin']).toBeDefined()
      expect(written.plugins.entries['weather-plugin'].config.api_key).toBe('sk-SECRET-USER-KEY-123')
      expect(written.plugins.entries['plur-claw']).toBeDefined()
    })

    it('preserves entries whose extension directory exists', () => {
      mkdirSync(join(dir, 'extensions', 'active-plugin'), { recursive: true })
      const prior = {
        plugins: {
          entries: {
            'plur-claw': { enabled: true },
            'active-plugin': { enabled: true },
          },
          slots: { memory: 'plur-claw' },
          allow: ['plur-claw'],
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      runSetup({ configPath: cfgPath, openclawHome: dir })
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
      expect(written.plugins.entries['active-plugin']).toBeDefined()
    })

    it('does not prune plur-claw entry even when extension dir is absent', () => {
      const prior = {
        plugins: {
          entries: { 'plur-claw': { enabled: true } },
          slots: { memory: 'plur-claw' },
          allow: ['plur-claw'],
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      runSetup({ configPath: cfgPath, openclawHome: dir })
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
      expect(written.plugins.entries['plur-claw']).toBeDefined()
      expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    })
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
      'allow_gated',
      'orphaned_entries',
      'reload_required',
      'runtime_registered',
      'telemetry_optin',
    ])
  })

  it('always marks reload_required as pending', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
    expect(r.steps.find((s) => s.step === 'reload_required')!.status).toBe('pending')
  })

  it('marks runtime_registered pending when plugin entrypoint is absent', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.status).toBe('pending')
  })

  it('marks runtime_registered ok when plugin entrypoint exists', () => {
    const distDir = join(dir, 'extensions', 'plur-claw', 'dist')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.js'), '', 'utf8')
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.status).toBe('ok')
    expect(r.steps.find((s) => s.step === 'runtime_registered')!.detail).toContain('verified')
  })

  it('surfaces telemetry as skip by default with no env or config', () => {
    const telemetryCfg = join(dir, 'telemetry.json')
    const r = runDoctor({ configPath: cfgPath, env: {}, telemetryConfigPath: telemetryCfg })
    const step = r.steps.find((s) => s.step === 'telemetry_optin')!
    expect(step.status).toBe('skip')
    expect(step.detail).toContain('off')
    expect(step.detail).toContain('default')
  })

  it('surfaces telemetry as ok when PLUR_TELEMETRY=on', () => {
    const telemetryCfg = join(dir, 'telemetry.json')
    const r = runDoctor({
      configPath: cfgPath,
      env: { PLUR_TELEMETRY: 'on' },
      telemetryConfigPath: telemetryCfg,
    })
    const step = r.steps.find((s) => s.step === 'telemetry_optin')!
    expect(step.status).toBe('ok')
    expect(step.detail).toContain('on')
    expect(step.detail).toContain('PLUR_TELEMETRY')
  })

  describe('allow_gated step (item 2 Option B + item 4)', () => {
    it('reports ok when plugins.allow is absent (no gating)', () => {
      const prior = {
        plugins: {
          entries: { 'plur-claw': { enabled: true } },
          slots: { memory: 'plur-claw' },
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      const r = runDoctor({ configPath: cfgPath })
      const step = r.steps.find((s) => s.step === 'allow_gated')!
      expect(step.status).toBe('ok')
    })

    it('reports ok when plur-claw is in plugins.allow', () => {
      const prior = {
        plugins: {
          entries: { 'plur-claw': { enabled: true } },
          slots: { memory: 'plur-claw' },
          allow: ['plur-claw'],
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      const r = runDoctor({ configPath: cfgPath })
      const step = r.steps.find((s) => s.step === 'allow_gated')!
      expect(step.status).toBe('ok')
    })

    it('reports fail with guidance when plugins.allow is an empty array', () => {
      const prior = {
        plugins: {
          entries: { 'plur-claw': { enabled: true } },
          slots: { memory: 'plur-claw' },
          allow: [],
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      const r = runDoctor({ configPath: cfgPath })
      const step = r.steps.find((s) => s.step === 'allow_gated')!
      expect(step.status).toBe('fail')
      expect(step.detail).toContain('empty')
      expect(step.detail).toContain('npx @plur-ai/claw setup')
    })

    it('reports fail when plugins.allow is non-empty but does not include plur-claw', () => {
      const prior = {
        plugins: {
          entries: { 'plur-claw': { enabled: true } },
          slots: { memory: 'plur-claw' },
          allow: ['some-other-plugin'],
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      const r = runDoctor({ configPath: cfgPath })
      const step = r.steps.find((s) => s.step === 'allow_gated')!
      expect(step.status).toBe('fail')
      expect(step.detail).toContain('plur-claw')
      expect(step.detail).toContain('npx @plur-ai/claw setup')
    })
  })

  // #583: the removed #51 / D-2 prune DELETED any plugins.entries[<id>] whose
  // extensions/<id> dir was absent, destroying third-party config (and API keys)
  // during the transient absence of a normal install/upgrade. These tests prove
  // the replacement DETECTS the same orphan condition WITHOUT ever mutating the
  // config, does not fire for a present plugin, and stays silent (never warns,
  // never fails) during a simulated whole-tree transient absence.
  describe('orphaned_entries step (#583 — non-destructive replacement for #51 prune)', () => {
    it('warns (does NOT delete) a genuinely-orphaned third-party entry and its API key', () => {
      const prior = {
        plugins: {
          entries: {
            'plur-claw': { enabled: true },
            'weather-plugin': { enabled: true, config: { api_key: 'sk-SECRET-USER-KEY-123' } },
          },
          slots: { memory: 'plur-claw' },
        },
      }
      const raw = JSON.stringify(prior)
      writeFileSync(cfgPath, raw, 'utf8')
      // extensions/ exists and plur-claw is installed, but weather-plugin is not:
      // a genuine, stable orphan — not a transient whole-tree absence.
      mkdirSync(join(dir, 'extensions', 'plur-claw'), { recursive: true })
      const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
      const step = r.steps.find((s) => s.step === 'orphaned_entries')!
      expect(step.status).toBe('warn')
      expect(step.detail).toContain('weather-plugin')
      expect(step.detail).toContain('ADVISORY ONLY')
      // Non-destructive: doctor must not rewrite the config, and warn must not fail.
      expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
      expect(r.steps.some((s) => s.status === 'fail')).toBe(false)
    })

    it('flags plur-claw itself when its own entry is orphaned', () => {
      const prior = {
        plugins: { entries: { 'plur-claw': { enabled: true } }, slots: { memory: 'plur-claw' } },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      // extensions/ exists (some other plugin present) but plur-claw's own dir is gone.
      mkdirSync(join(dir, 'extensions', 'other-plugin'), { recursive: true })
      const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
      const step = r.steps.find((s) => s.step === 'orphaned_entries')!
      expect(step.status).toBe('warn')
      expect(step.detail).toContain('plur-claw')
    })

    it('does NOT warn when every entry has a backing extension (present plugin)', () => {
      const prior = {
        plugins: {
          entries: { 'plur-claw': { enabled: true }, 'active-plugin': { enabled: true } },
          slots: { memory: 'plur-claw' },
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      mkdirSync(join(dir, 'extensions', 'plur-claw'), { recursive: true })
      mkdirSync(join(dir, 'extensions', 'active-plugin'), { recursive: true })
      const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
      const step = r.steps.find((s) => s.step === 'orphaned_entries')!
      expect(step.status).toBe('ok')
    })

    it('stays silent (skip, never warn) during a simulated transient whole-tree absence', () => {
      // The exact false-positive that made the removed prune destructive: mid
      // install/upgrade the extensions/ tree is not yet populated. With the dir
      // absent we cannot tell orphaned from transient, so we must NOT warn.
      const prior = {
        plugins: {
          entries: {
            'plur-claw': { enabled: true },
            'weather-plugin': { enabled: true, config: { api_key: 'sk-SECRET' } },
          },
          slots: { memory: 'plur-claw' },
        },
      }
      writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
      // Note: dir/extensions is intentionally NOT created.
      const r = runDoctor({ configPath: cfgPath, openclawHome: dir })
      const step = r.steps.find((s) => s.step === 'orphaned_entries')!
      expect(step.status).toBe('skip')
      expect(step.detail).toContain('cannot assess')
    })
  })
})

describe('claw setup --repair mode', () => {
  let dir: string
  let cfgPath: string
  beforeEach(() => {
    dir = newDir()
    cfgPath = join(dir, 'openclaw.json')
  })

  it('no-ops when doctor reports enable + slot + hooks healthy', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true, config: { injection_budget: 4000 }, hooks: { allowConversationAccess: true } } },
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
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    const r = runRepair({ configPath: cfgPath })
    const slotStep = r.steps.find((s) => s.step === 'slot_selected')!
    expect(slotStep.status).toBe('fail')
    expect(slotStep.detail).toContain('other-memory')
    // Slot conflict preserved — slot still points to other plugin.
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.slots.memory).toBe('other-memory')
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

  it('sets hooks.allowConversationAccess during repair', () => {
    const prior = {
      plugins: {
        entries: { 'plur-claw': { enabled: true } },
        slots: { memory: 'plur-claw' },
      },
    }
    writeFileSync(cfgPath, JSON.stringify(prior), 'utf8')
    runRepair({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.entries['plur-claw'].hooks?.allowConversationAccess).toBe(true)
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
