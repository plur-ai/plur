/**
 * #1311 review follow-ups (carried by #1270):
 *  2. the mcp.plur upgrade/repair line names what was actually written — the
 *     node.exe launcher, or the cmd.exe /c npx fallback;
 *  3. the opencode config dir is resolved the way opencode resolves it:
 *     OPENCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/opencode, else
 *     ~/.config/opencode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { opencodeConfigDir, writeOpencodeConfig, opencodeMcpNote } from '../src/opencode-config.js'

const CLI = builtCliPath(join(__dirname, '..'))
const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })
// Restore by key: replacing process.env with a plain object would cut it off
// from the real environment that os.homedir() reads.
const KEYS = ['HOME', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const
const snapshot = () => Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
function restore(saved: Record<string, string | undefined>): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

describe('opencodeConfigDir follows opencode (#1311 review)', () => {
  const saved = snapshot()
  afterEach(() => { restore(saved) })

  it('uses OPENCODE_CONFIG_DIR first', () => {
    process.env.OPENCODE_CONFIG_DIR = '/custom/oc'
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(opencodeConfigDir()).toBe('/custom/oc')
  })

  it('then $XDG_CONFIG_HOME/opencode', () => {
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(opencodeConfigDir()).toBe(join('/xdg', 'opencode'))
  })

  it('then ~/.config/opencode (an empty variable counts as unset)', () => {
    process.env.OPENCODE_CONFIG_DIR = ''
    process.env.XDG_CONFIG_HOME = ''
    process.env.HOME = '/home/u'
    expect(opencodeConfigDir()).toBe(join('/home/u', '.config', 'opencode'))
  })
})

describe('the mcp.plur rewrite line says what was written (#1311 review)', () => {
  let home: string
  const saved = snapshot()
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-oc-note-'))
    process.env.HOME = home
  })
  afterEach(() => {
    setPlatform(realPlatform)
    restore(saved)
    rmSync(home, { recursive: true, force: true })
  })

  it('names the cmd.exe /c npx fallback when the js entry cannot be resolved', () => {
    // No ~/.plur/bin/plur-mcp.meta.json → no js entry → fallback.
    const cfgPath = join(home, 'opencode.json')
    writeFileSync(cfgPath, JSON.stringify({ mcp: { plur: { type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.20.0'], enabled: true } } }))
    setPlatform('win32')
    const result = writeOpencodeConfig(cfgPath, '0.20.1')
    expect(result.mcpPlurUpgraded).toBe(true)
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).mcp.plur.command[0]).toBe('cmd.exe')
    const note = opencodeMcpNote(result)
    expect(note).toContain('cmd.exe /c npx')
    expect(note).not.toContain('node.exe + @plur-ai/mcp')
  })

  it('names the node.exe launcher when that is what was written', () => {
    const js = join(home, 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'mcp', 'dist'), { recursive: true })
    writeFileSync(js, '')
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
    writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'), JSON.stringify({ entrypoint: js }))
    const cfgPath = join(home, 'opencode.json')
    writeFileSync(cfgPath, JSON.stringify({ mcp: { plur: { type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.20.0'], enabled: true } } }))
    setPlatform('win32')
    const note = opencodeMcpNote(writeOpencodeConfig(cfgPath, '0.20.1'))
    expect(note).toContain('node.exe')
    expect(note).not.toContain('cmd.exe')
  })
})

describe('plur init writes to the opencode dir opencode reads (#1311 review)', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-oc-xdg-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function runInit(env: Record<string, string>): string {
    const base = { ...process.env }
    delete base.OPENCODE_CONFIG_DIR
    delete base.XDG_CONFIG_HOME
    return execFileSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-cursor'], {
      encoding: 'utf-8', timeout: 30000, cwd: home,
      env: { ...base, HOME: home, USERPROFILE: home, PLUR_PATH: join(home, '.plur'), ...env },
    })
  }

  it('uses $XDG_CONFIG_HOME/opencode, not a leftover ~/.config/opencode', () => {
    const xdg = join(home, 'xdg')
    mkdirSync(join(xdg, 'opencode'), { recursive: true })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    const out = runInit({ XDG_CONFIG_HOME: xdg })
    expect(existsSync(join(xdg, 'opencode', 'opencode.json'))).toBe(true)
    expect(existsSync(join(home, '.config', 'opencode', 'opencode.json'))).toBe(false)
    expect(out).toContain(join(xdg, 'opencode', 'opencode.json'))
  })

  it('uses OPENCODE_CONFIG_DIR when set', () => {
    const custom = join(home, 'my-oc')
    mkdirSync(custom, { recursive: true })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    runInit({ OPENCODE_CONFIG_DIR: custom })
    expect(existsSync(join(custom, 'opencode.json'))).toBe(true)
    expect(existsSync(join(home, '.config', 'opencode', 'opencode.json'))).toBe(false)
  })
})
