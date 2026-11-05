/**
 * #1832 — after a global upgrade (`npm i -g @plur-ai/cli@latest
 * @plur-ai/mcp@latest`), `plur init` must move every tool config PLUR wrote
 * to the new version. An entry that launches the installed MCP server (the
 * `~/.plur/bin/plur-mcp` shim) follows the upgrade at the same path; an npx
 * entry records an exact version (never `@latest`, #1069), so init re-pins a
 * PLUR pin older than or equal to the running CLI. A newer pin, a fork and a
 * custom command are the user's and stay — the rule the Codex writer already
 * applies (codexLaunchKind).
 *
 * Here the running CLI is simulated as a newer release (CLI_VERSION mocked to
 * 0.30.0); the shim's presence or absence is the temp HOME's
 * `~/.plur/bin/plur-mcp`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../src/version.js', () => ({ CLI_VERSION: '0.30.0' }))

const { healPlurMcpEntry, plurNpxPin, buildMcpServerEntry } = await import('../src/mcp-config.js')
const { writeOpencodeConfig, opencodeMcpNote } = await import('../src/opencode-config.js')

const realPlatform = process.platform
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

let home: string
let savedHome: string | undefined
let savedProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-1832-'))
  savedHome = process.env.HOME
  savedProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  setPlatform(realPlatform)
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile
  rmSync(home, { recursive: true, force: true })
})

/** A global install of @plur-ai/mcp that `plur init` turned into the shim. */
function installShim(): string {
  mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
  const shim = join(home, '.plur', 'bin', 'plur-mcp')
  writeFileSync(shim, '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 })
  return shim
}

const heal = (plur: Record<string, unknown>) => {
  const config = { mcpServers: { plur } } as Record<string, unknown>
  const label = healPlurMcpEntry(config)
  return { label, entry: (config.mcpServers as Record<string, Record<string, unknown>>).plur }
}

const shapes = (spec: string): Array<[string, Record<string, unknown>]> => [
  ['/bin/sh -lc (init on macOS/Linux)', { command: '/bin/sh', args: ['-lc', `exec npx -y ${spec}`] }],
  ['npx argv', { command: 'npx', args: ['-y', spec] }],
]

describe.skipIf(realPlatform === 'win32')('JSON tool configs (Claude Code, Desktop, Cursor, Antigravity) follow a global upgrade (#1832)', () => {
  for (const [name, entry] of shapes('@plur-ai/mcp@0.22.0')) {
    it(`${name}: an older pin, no installed MCP → re-pinned to the running CLI`, () => {
      const { label, entry: after } = heal(entry)
      expect(label).toBe('updated the npx pin 0.22.0 → 0.30.0')
      expect(after).toEqual({ command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.30.0'] })
    })

    it(`${name}: an older pin, installed MCP → the shim (follows later upgrades with no re-pin)`, () => {
      const shim = installShim()
      const { label, entry: after } = heal(entry)
      expect(label).toBe('replaced the pinned npx entry (0.22.0) with the installed MCP server')
      expect(after).toEqual({ command: shim, args: [] })
    })
  }

  it('an equal pin with the MCP installed → the shim', () => {
    const shim = installShim()
    expect(heal({ command: 'npx', args: ['-y', '@plur-ai/mcp@0.30.0'] }).entry).toEqual({ command: shim, args: [] })
  })

  it('an equal pin with no MCP installed → unchanged', () => {
    const entry = { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.30.0'] }
    expect(heal(entry)).toEqual({ label: null, entry })
  })

  it('a newer pin is the user\'s and stays, shim or not', () => {
    installShim()
    const entry = { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.31.0'] }
    expect(heal(entry)).toEqual({ label: null, entry })
  })

  it('a fork, a tag, a range and a custom command stay', () => {
    for (const entry of [
      { command: 'npx', args: ['-y', '@plur-ai/mcp-experimental@0.22.0'] },
      { command: 'npx', args: ['-y', '@plur-ai/mcp@next'] },
      { command: 'npx', args: ['-y', '@plur-ai/mcp@^0.22.0'] },
      { command: '/opt/wrap', args: ['--', 'npx', '-y', '@plur-ai/mcp@0.22.0'] },
    ]) expect(heal(entry)).toEqual({ label: null, entry })
  })

  it('the re-pin keeps env and unmodeled fields', () => {
    const { entry } = heal({ command: 'npx', args: ['-y', '@plur-ai/mcp@0.22.0'], env: { PLUR_PATH: '/x' }, timeout: 30 })
    expect(entry).toEqual({ command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.30.0'], env: { PLUR_PATH: '/x' }, timeout: 30 })
  })

  it('a fresh entry never records @latest', () => {
    expect(JSON.stringify(buildMcpServerEntry())).toContain('@plur-ai/mcp@0.30.0')
    expect(JSON.stringify(buildMcpServerEntry())).not.toContain('@latest')
  })
})

describe('Windows: cmd.exe /c npx pins follow too (#1832)', () => {
  it('an older pin with no js entry is re-pinned in the cmd.exe form', () => {
    setPlatform('win32')
    const { label, entry } = heal({ command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp@0.22.0'] })
    expect(label).toBe('updated the npx pin 0.22.0 → 0.30.0')
    expect(entry).toEqual({ command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp@0.30.0'] })
  })
})

describe('plurNpxPin', () => {
  it.each([
    [{ command: 'npx', args: ['-y', '@plur-ai/mcp'] }, 'latest'],
    [{ command: 'npx', args: ['-y', '@plur-ai/mcp@latest'] }, 'latest'],
    [{ command: 'npx', args: ['-y', '@plur-ai/mcp@0.22.0'] }, '0.22.0'],
    [{ command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp@0.23.0-rc.1'] }, '0.23.0-rc.1'],
    [{ command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.22.0'] }, '0.22.0'],
    [{ command: '/bin/sh', args: ['-lc', 'npx -y @plur-ai/mcp@0.22.0; other'] }, null],
    [{ command: 'npx', args: ['-y', '@plur-ai/mcp@next'] }, null],
    [{ command: '/usr/local/bin/plur-mcp', args: [] }, null],
  ])('%j → %s', (entry, expected) => expect(plurNpxPin(entry)).toBe(expected))
})

describe.skipIf(realPlatform === 'win32')('OpenCode follows a global upgrade (#1832, #1591)', () => {
  const legacy = (pin: string) => ({ mcp: { plur: { type: 'local', command: ['npx', '-y', `@plur-ai/mcp@${pin}`], environment: { HTTPS_PROXY: 'http://proxy.example.com:8080' }, enabled: true } } })

  it('no installed MCP: an older pin is re-pinned to the running CLI, other fields kept', () => {
    const cfg = join(home, 'opencode.json')
    writeFileSync(cfg, JSON.stringify(legacy('0.22.0')))
    const r = writeOpencodeConfig(cfg, '0.30.0')
    expect(r.mcpPlurRepinned).toEqual({ from: '0.22.0', to: '0.30.0' })
    expect(r.mcpPlurPreserved).toBe(false)
    expect(JSON.parse(readFileSync(cfg, 'utf8')).mcp.plur).toEqual({
      type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.30.0'], environment: { HTTPS_PROXY: 'http://proxy.example.com:8080' }, enabled: true,
    })
    expect(opencodeMcpNote(r)).toBe('\n  mcp.plur: updated the npx pin 0.22.0 → 0.30.0; other fields kept')
  })

  it('installed MCP: an older pin becomes the shim', () => {
    const shim = installShim()
    const cfg = join(home, 'opencode.json')
    writeFileSync(cfg, JSON.stringify(legacy('0.22.0')))
    expect(writeOpencodeConfig(cfg, '0.30.0').mcpPlurUpgraded).toBe(true)
    expect(JSON.parse(readFileSync(cfg, 'utf8')).mcp.plur.command).toEqual([shim])
  })

  it('a newer pin and an equal pin stay', () => {
    for (const pin of ['0.31.0', '0.30.0']) {
      const cfg = join(home, `opencode-${pin}.json`)
      writeFileSync(cfg, JSON.stringify(legacy(pin)))
      const r = writeOpencodeConfig(cfg, '0.30.0')
      expect(r.mcpPlurRepinned).toBeUndefined()
      expect(JSON.parse(readFileSync(cfg, 'utf8')).mcp.plur.command).toEqual(['npx', '-y', `@plur-ai/mcp@${pin}`])
    }
  })

  it('JSONC: only the pin changes; comments survive', () => {
    const cfg = join(home, 'opencode.jsonc')
    const src = '{\n  // my servers\n  "mcp": {\n    "plur": { "type": "local", "command": ["npx", "-y", "@plur-ai/mcp@0.22.0"], "enabled": true } // keep me\n  }\n}\n'
    writeFileSync(cfg, src)
    writeOpencodeConfig(cfg, '0.30.0', { upgradePlugin: false })
    const out = readFileSync(cfg, 'utf8')
    expect(out).toContain('// my servers')
    expect(out).toContain('// keep me')
    expect(out).toContain('"@plur-ai/mcp@0.30.0"')
    expect(out).not.toContain('0.22.0')
  })
})
