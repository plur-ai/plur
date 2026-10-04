/**
 * #1302 and #1339 — a node-form MCP entry whose command is a bare `node` /
 * `node.exe` is resolved through PATH when it is spawned. PLUR always writes
 * an absolute node path, so such an entry is the user's: doctor must not call
 * it missing, and init must neither pin it to the version-specific
 * `process.execPath` nor downgrade it to the npx fallback. The opencode leg
 * of doctor also reports a stale absolute node path in `mcp.plur` (#1339).
 *
 * Windows behaviour is exercised with the process.platform stub (unit tests)
 * and the win32 preload (spawned doctor), not on real Windows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { missingNodeEntryPaths, upgradePlurMcpEntry } from '../src/mcp-config.js'
import { writeOpencodeConfig, readOpencodeConfig } from '../src/opencode-config.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href
const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

describe('a PATH-resolved node entry is the user\'s (#1302, #1339)', () => {
  let home: string
  let savedHome: string | undefined
  let js: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-1302-'))
    savedHome = process.env.HOME
    process.env.HOME = home
    js = join(home, 'npm', 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'npm', 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
    writeFileSync(js, '')
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
  })
  afterEach(() => {
    setPlatform(realPlatform)
    process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })
  // plur-mcp.meta.json, as `plur init` records it, naming another js entry.
  const recordOtherEntry = () => {
    const other = join(home, 'other', 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'other', 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
    writeFileSync(other, '')
    writeFileSync(join(home, '.plur', 'bin', 'plur-mcp.meta.json'), JSON.stringify({ entrypoint: other }))
  }

  it.each([['node'], ['node.exe'], ['NODE.EXE']])('doctor: a bare %s is never missing', (command) => {
    setPlatform('win32')
    expect(missingNodeEntryPaths({ command, args: [js] })).toEqual([])
    // The js entry is still checked.
    expect(missingNodeEntryPaths({ command, args: [join(home, 'gone', '@plur-ai', 'mcp', 'dist', 'index.js')] })).toHaveLength(1)
  })

  it.each([[false], [true]])('init (Claude Code / Cursor / Desktop): a bare node is never rewritten (meta file: %s)', (withMeta) => {
    if (withMeta) recordOtherEntry()
    setPlatform('win32')
    const plur = { command: 'node', args: [js], cwd: 'keep' }
    const config: Record<string, unknown> = { mcpServers: { plur: { ...plur } } }
    expect(upgradePlurMcpEntry(config)).toBe(false)
    expect((config.mcpServers as Record<string, unknown>).plur).toEqual(plur)
  })

  it.each([[false], [true]])('init (opencode): a bare node is left as is, never pinned or downgraded (meta file: %s)', (withMeta) => {
    if (withMeta) recordOtherEntry()
    setPlatform('win32')
    const cfgPath = join(home, 'opencode.json')
    const plur = { type: 'local', command: ['node', js], enabled: true }
    writeFileSync(cfgPath, JSON.stringify({ plugin: ['@plur-ai/opencode'], mcp: { plur } }))
    const result = writeOpencodeConfig(cfgPath, '0.21.0')
    expect(result.mcpPlurRepaired).toBe(false)
    expect(result.mcpPlurPreserved).toBe(true)
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).mcp.plur).toEqual(plur)
  })

  it('an absolute node path that is gone is still healed and reported', () => {
    setPlatform('win32')
    const stale = { command: 'C:\\Program Files\\nodejs-22.1.0\\node.exe', args: [js] }
    expect(missingNodeEntryPaths(stale)).toEqual([stale.command])
    const cfgPath = join(home, 'opencode.json')
    writeFileSync(cfgPath, JSON.stringify({ mcp: { plur: { type: 'local', command: [stale.command, js], enabled: true } } }))
    expect(readOpencodeConfig(cfgPath).mcpPlurMissingPaths).toEqual([stale.command])
  })
})

describe('plur doctor on the win32 stub (#1302, #1339)', { timeout: 60000 }, () => {
  let home: string
  let js: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-1302-doc-'))
    js = join(home, 'npm', 'node_modules', '@plur-ai', 'mcp', 'dist', 'index.js')
    mkdirSync(join(home, 'npm', 'node_modules', '@plur-ai', 'mcp', 'dist'), { recursive: true })
    writeFileSync(js, '')
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function doctor(): any {
    let out = ''
    try {
      out = execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI, 'doctor', '--no-handshake', '--json'], {
        encoding: 'utf-8', timeout: 30000, cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' },
      })
    } catch (err: any) { out = err.stdout?.toString() ?? '' }
    return JSON.parse(out)
  }

  it('does not report a bare-node Claude Code entry as broken', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { plur: { command: 'node', args: [js] } } }))
    expect(doctor().brokenNodeMcp).toEqual([])
  })

  it('reports a stale absolute node path in opencode\'s mcp.plur, and not a bare node', () => {
    const dir = join(home, '.config', 'opencode')
    mkdirSync(dir, { recursive: true })
    const gone = 'C:\\Program Files\\nodejs-22.1.0\\node.exe'
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ mcp: { plur: { type: 'local', command: [gone, js], enabled: true } } }))
    expect(doctor().opencode.mcpPlurMissingPaths).toEqual([gone])
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ mcp: { plur: { type: 'local', command: ['node', js], enabled: true } } }))
    expect(doctor().opencode.mcpPlurMissingPaths).toEqual([])
  })
})
