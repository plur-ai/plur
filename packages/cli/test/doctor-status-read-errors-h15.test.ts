/**
 * H15: when doctor or status cannot read something they report on, they say
 * so instead of printing nothing — config.yaml for the invalid-value check,
 * the pin report, and the store health. In --json each gets an error field.
 * And the doctor line for an invalid `pinning.agents` names the value that is
 * in effect ("request", the schema's safe fallback), not "the default".
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { readInvalidConfigKeys, invalidConfigKeyLines, readPinOverflow, printText } from '../src/commands/doctor.js'

let dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'plur-h15-')); dirs.push(d); return d }
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function captureText(fn: () => unknown): Promise<string> | string {
  let text = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => { text += c; return true }) as never)
  const done = () => { spy.mockRestore(); return text }
  try {
    const r = fn()
    if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).then(done, e => { done(); throw e })
  } catch (e) { done(); throw e }
  return done()
}

describe('doctor (H15)', () => {
  it('an unparseable config.yaml is reported as unreadable, not as "no invalid values"', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.yaml'), 'injection: [unclosed\n')
    const r = readInvalidConfigKeys({ path: dir })
    expect(r.keys).toEqual([])
    expect(r.error).toMatch(/\S/)
    const text = invalidConfigKeyLines(r.keys, r.error).join('\n')
    expect(text).toMatch(/could not read .*config\.yaml/)
    expect(readInvalidConfigKeys({ path: tmp() })).toEqual({ keys: [] })
  })

  it('an invalid pinning.agents names the value in effect, "request"', () => {
    const text = invalidConfigKeyLines(['injection.mode', 'pinning.agents']).join('\n')
    expect(text).toContain('pinning.agents')
    expect(text).toMatch(/pinning\.agents[^,\n]*"request"/)
    expect(text).toMatch(/injection\.mode[^,\n]*default/)
  })

  it('a pin report that cannot be read is an error', async () => {
    vi.spyOn(Plur.prototype, 'pinFitReport').mockRejectedValue(new Error('engrams.yaml: bad indentation'))
    const r = await readPinOverflow({ path: tmp() })
    expect(r.pinOverflow).toBeNull()
    expect(r.error).toContain('bad indentation')
  })

  it('a spawned doctor --json carries the read errors, and the text report prints them', async () => {
    const home = tmp()
    const root = join(home, '.plur')
    mkdirSync(root)
    writeFileSync(join(root, 'config.yaml'), 'injection: [unclosed\n')
    const r = spawnSync(process.execPath, [builtCliPath(join(__dirname, '..')), 'doctor', '--no-handshake', '--json'],
      { cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' }, encoding: 'utf8', timeout: 90_000 })
    const report = JSON.parse(r.stdout)
    expect(report.invalidConfigKeysError, r.stderr).toMatch(/\S/)
    // The renderer prints what --json carries; a pin-report error is set by hand here.
    report.pinOverflowError = 'engrams.yaml: bad indentation'
    const text = captureText(() => printText(report)) as string
    expect(text).toMatch(/could not read .*config\.yaml/)
    expect(text).toMatch(/could not read the pin report: engrams\.yaml: bad indentation/)
  }, 120_000)
})

describe('status (H15)', () => {
  it('a store-health failure prints a "could not read" line, and --json carries store_health_error', async () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    vi.spyOn(Plur.prototype, 'storeHealth').mockRejectedValue(new Error('cache file truncated'))
    const { run } = await import('../src/commands/status.js')
    const text = await captureText(() => run([], { path: dir, json: false }))
    expect(text).toMatch(/Store health: could not read: cache file truncated/)
    const json = await captureText(() => run([], { path: dir, json: true }))
    expect(JSON.parse(json).store_health_error).toBe('cache file truncated')
  })
})
