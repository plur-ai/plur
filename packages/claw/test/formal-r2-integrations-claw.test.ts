/**
 * Formal verification round 2 (R2-Integrations, mcp-integrations#11).
 *
 * setup (postinstall) and repair must agree: neither takes a memory slot a
 * foreign plugin holds, and neither rewrites a `plugins` (or `entries`,
 * `slots`, `mcp`) value it cannot read as an object — both leave the file
 * untouched and say why. The context engine marks a statement learned only
 * once its write succeeded (a failed write can be retried), and its
 * per-session state is bounded.
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §5.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSetup, runRepair } from '../src/setup.js'
import { PlurContextEngine, MAX_TRACKED_SESSIONS } from '../src/context-engine.js'

describe('setup and repair agree on foreign and malformed config', () => {
  let dir: string
  let cfgPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-r2-'))
    cfgPath = join(dir, 'openclaw.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('setup does NOT take a memory slot held by another plugin (repair already refuses)', () => {
    writeFileSync(cfgPath, JSON.stringify({ plugins: { slots: { memory: 'other-memory' } } }), 'utf8')
    const r = runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.slots.memory).toBe('other-memory')
    // plur-claw is still enabled — only the slot is left to the human.
    expect(written.plugins.entries['plur-claw'].enabled).toBe(true)
    const slot = r.steps.find(s => s.step === 'slot_selected')!
    expect(slot.status).toBe('fail')
    expect(slot.detail).toContain('other-memory')
  })

  for (const [label, plugins] of [
    ['a string', 'disabled-by-admin'],
    ['an array', ['a', 'b']],
    ['a number', 7],
  ] as const) {
    it(`setup leaves the file untouched when plugins is ${label}`, () => {
      const raw = JSON.stringify({ plugins, other: 1 })
      writeFileSync(cfgPath, raw, 'utf8')
      const r = runSetup({ configPath: cfgPath })
      expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
      expect(r.steps.find(s => s.step === 'plugin_enabled')!.status).toBe('fail')
      expect(r.steps.find(s => s.step === 'plugin_enabled')!.detail).toMatch(/not an object/)
      expect(r.fallbackBlock).toContain('plur-claw')
    })

    it(`repair leaves the file untouched when plugins is ${label}`, () => {
      const raw = JSON.stringify({ plugins, other: 1 })
      writeFileSync(cfgPath, raw, 'utf8')
      runRepair({ configPath: cfgPath })
      expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
    })
  }

  it('setup leaves the file untouched when plugins.entries is not an object', () => {
    const raw = JSON.stringify({ plugins: { entries: 'x', slots: { memory: 'plur-claw' } } })
    writeFileSync(cfgPath, raw, 'utf8')
    runSetup({ configPath: cfgPath })
    expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
  })

  it('good case: an ordinary config is still enabled and slotted', () => {
    writeFileSync(cfgPath, JSON.stringify({ plugins: { entries: { other: { enabled: true } } } }), 'utf8')
    runSetup({ configPath: cfgPath })
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(written.plugins.slots.memory).toBe('plur-claw')
    expect(written.plugins.entries.other.enabled).toBe(true)
  })
})

describe('context engine: learned-mark and session state', () => {
  let dir: string
  let engine: PlurContextEngine
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-r2-ce-'))
    engine = new PlurContextEngine({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const correction = { role: 'user' as const, content: 'No, always use snake_case for the API responses in this project' }

  it('a failed learn is not marked learned — the next occurrence retries it', async () => {
    const spy = vi.spyOn(engine.plur, 'learnRouted').mockRejectedValueOnce(new Error('store locked'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await engine.ingest({ sessionId: 's1', message: correction })
    await engine.settle()
    await engine.ingest({ sessionId: 's1', message: correction })
    await engine.settle()
    expect(spy).toHaveBeenCalledTimes(2)
    errSpy.mockRestore()
  })

  it('good case: a successful learn is still not repeated in the same session', async () => {
    const spy = vi.spyOn(engine.plur, 'learnRouted')
    await engine.ingest({ sessionId: 's1', message: correction })
    await engine.settle()
    await engine.ingest({ sessionId: 's1', message: correction })
    await engine.settle()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('per-session state stays bounded across many top-level sessions', async () => {
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 25; i++) {
      await engine.bootstrap({ sessionId: `s${i}`, sessionKey: `k${i}`, sessionFile: '/dev/null' })
      await engine.ingest({ sessionId: `s${i}`, sessionKey: `k${i}`, message: { role: 'user', content: 'hello' } })
    }
    const sizes = engine.sessionStateSizes()
    expect(sizes.scopes).toBeLessThanOrEqual(MAX_TRACKED_SESSIONS)
    expect(sizes.messages).toBeLessThanOrEqual(MAX_TRACKED_SESSIONS)
    expect(sizes.learned).toBeLessThanOrEqual(MAX_TRACKED_SESSIONS)
    // The most recent session is kept.
    expect(engine.getSessionScope(`k${MAX_TRACKED_SESSIONS + 24}`)).toBe(`session:k${MAX_TRACKED_SESSIONS + 24}`)
  })
})
