import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, type PostinstallEnv } from '../src/postinstall.js'

function newHome(): string {
  return mkdtempSync(join(tmpdir(), 'plur-postinstall-home-'))
}

function baseEnv(home: string, overrides: Partial<PostinstallEnv> = {}): PostinstallEnv {
  return {
    cwd: '/some/consumer/project/node_modules/@plur-ai/claw',
    initCwd: '/some/consumer/project',
    openclawHome: join(home, '.openclaw'),
    ci: false,
    skip: false,
    isTTY: true,
    home,
    ...overrides,
  }
}

describe('claw postinstall decide()', () => {
  let home: string
  beforeEach(() => {
    home = newHome()
  })

  it('skips when CI is set', () => {
    expect(decide(baseEnv(home, { ci: true })).kind).toBe('skip')
  })

  it('skips when PLUR_SKIP_POSTINSTALL is set', () => {
    expect(decide(baseEnv(home, { skip: true })).kind).toBe('skip')
  })

  it('skips when INIT_CWD equals cwd (self-install in package dir)', () => {
    expect(decide(baseEnv(home, { cwd: '/pkg', initCwd: '/pkg' })).kind).toBe('skip')
  })

  it('prints prompt-setup message when config file does not yet exist', () => {
    const d = decide(baseEnv(home))
    expect(d.kind).toBe('prompt-setup')
    if (d.kind !== 'prompt-setup') return
    expect(d.message).toContain('npx @plur-ai/claw setup')
    expect(d.configPath).toBeNull()
  })

  it('prints prompt-setup message when config exists but plugin not enabled', () => {
    const cfgDir = join(home, '.openclaw')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'openclaw.json'), JSON.stringify({ plugins: { entries: {} } }), 'utf8')
    const d = decide(baseEnv(home))
    expect(d.kind).toBe('prompt-setup')
    if (d.kind !== 'prompt-setup') return
    expect(d.message).toContain('Run: npx @plur-ai/claw setup')
  })

  it('reports already-enabled when plugin is enabled in config', () => {
    const cfgDir = join(home, '.openclaw')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'openclaw.json'),
      JSON.stringify({ plugins: { entries: { 'plur-claw': { enabled: true } } } }),
      'utf8',
    )
    const d = decide(baseEnv(home))
    expect(d.kind).toBe('already-enabled')
    if (d.kind !== 'already-enabled') return
    expect(d.message).toContain('already enabled')
  })

  it('honors OPENCLAW_HOME override', () => {
    const custom = join(home, 'custom-openclaw')
    mkdirSync(custom, { recursive: true })
    writeFileSync(
      join(custom, 'openclaw.json'),
      JSON.stringify({ plugins: { entries: { 'plur-claw': { enabled: true } } } }),
      'utf8',
    )
    const d = decide(baseEnv(home, { openclawHome: custom }))
    expect(d.kind).toBe('already-enabled')
    if (d.kind !== 'already-enabled') return
    expect(d.configPath).toBe(join(custom, 'openclaw.json'))
  })

  it('treats malformed JSON as not-enabled (prompts setup without throwing)', () => {
    const cfgDir = join(home, '.openclaw')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'openclaw.json'), '{not json', 'utf8')
    expect(decide(baseEnv(home)).kind).toBe('prompt-setup')
  })
})
