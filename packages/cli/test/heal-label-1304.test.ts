/**
 * #1304 — init's status line must name what it actually healed. It said
 * "upgraded stale npx entry" for every rewrite, including the Windows
 * `.cmd`-shim and node-form heals (#1267), which have nothing to do with npx.
 *
 * Windows behaviour is exercised with the process.platform stub and the
 * win32 preload, not on real Windows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { healPlurMcpEntry } from '../src/mcp-config.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href
const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

describe('healPlurMcpEntry names the heal (#1304)', () => {
  let home: string
  let savedHome: string | undefined
  let js: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-1304-'))
    savedHome = process.env.HOME
    process.env.HOME = home
    js = join(home, 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
    writeFileSync(js, '')
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
    writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'), JSON.stringify({ entrypoint: js }))
  })
  afterEach(() => {
    setPlatform(realPlatform)
    process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })
  const heal = (plur: Record<string, unknown>) => healPlurMcpEntry({ mcpServers: { plur } })

  it('the @latest npx entry: "upgraded stale npx entry"', () => {
    setPlatform('win32')
    expect(heal({ command: 'npx', args: ['-y', '@plur-ai/mcp@latest'] })).toBe('upgraded stale npx entry')
  })

  it('the Windows .cmd shim entry: names the shim and the node.exe launcher, not npx', () => {
    setPlatform('win32')
    const label = heal({ command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: [] })
    expect(label).toContain('plur-mcp.cmd')
    expect(label).toContain('node.exe + @plur-ai/mcp')
    expect(label).not.toContain('npx')
  })

  it('the Windows node-form entry with a gone node.exe: names the repair, not npx', () => {
    setPlatform('win32')
    const label = heal({ command: 'C:\\Program Files\\nodejs-22.1.0\\node.exe', args: [js] })
    expect(label).toContain('repaired the node.exe entry')
    expect(label).not.toContain('npx')
  })

  it('names the cmd.exe /c npx fallback when that is what was written', () => {
    rmSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'))
    setPlatform('win32')
    expect(heal({ command: 'C:\\Users\\Test User\\.plur\\bin\\plur-mcp.cmd', args: [] })).toContain('cmd.exe /c npx fallback')
  })

  it('null when nothing was rewritten', () => {
    setPlatform('win32')
    expect(heal({ command: 'C:\\custom\\run.cmd', args: [] })).toBeNull()
  })
})

describe('plur init on the win32 stub prints the heal it did (#1304)', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-1304-init-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('an old plur-mcp.cmd entry in Claude Code settings', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const shim = join(home, '.plur', 'bin', 'plur-mcp.cmd')
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { plur: { command: shim, args: [] } } }))
    const out = execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-opencode', '--no-prompt'], {
      encoding: 'utf-8', timeout: 30000, cwd: home, env: isolatedHomeEnv(home),
    })
    expect(out).toContain('healed the old plur-mcp.cmd entry')
    expect(out).not.toContain('upgraded stale npx entry')
  })
})
