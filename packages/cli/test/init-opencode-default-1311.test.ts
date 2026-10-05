/**
 * #1311 — `plur init` sets up opencode by default.
 *
 * `@plur-ai/opencode` is published, so the opt-in gate that guarded against
 * writing a dead plugin name is gone: whenever opencode's config dir exists
 * (`~/.config/opencode`, the same detection `opencode-config.ts` uses), init
 * writes the plugin entry and the MCP entry with no flag. `--opencode` still
 * forces it (and creates the dir), `--no-opencode` skips it.
 *
 * On win32 the MCP entry is built by the same builder PR #1270 added for
 * every other host, so it is `[<node.exe>, <@plur-ai/mcp js entry>]`, never a
 * bare `npx` (which a shell-less spawn cannot resolve to `npx.cmd`).
 *
 * The built CLI is spawned under a throwaway HOME, so neither the real
 * `~/.plur` nor the real opencode config is ever touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

describe('plur init sets up opencode by default (#1311)', { timeout: 60000 }, () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-oc-1311-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const ocDir = () => join(home, '.config', 'opencode')
  const ocJson = () => join(ocDir(), 'opencode.json')
  const readOc = () => JSON.parse(readFileSync(ocJson(), 'utf-8'))

  function runInit(extra: string[] = [], win32 = false): string {
    const nodeArgs = win32 ? ['--import', WIN32_PRELOAD] : []
    return execFileSync(process.execPath, [...nodeArgs, CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-cursor', ...extra], {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PLUR_PATH: join(home, '.plur'),
        XDG_CONFIG_HOME: join(home, '.config'),
        OPENCODE_CONFIG_DIR: ocDir(),
      },
      cwd: home,
    })
  }

  it('writes the plugin and MCP entry with no flag when the opencode config dir exists', () => {
    mkdirSync(ocDir(), { recursive: true })
    const out = runInit()
    const cfg = readOc()
    expect(cfg.plugin).toEqual(['@plur-ai/opencode'])
    expect(cfg.mcp.plur.type).toBe('local')
    expect(cfg.mcp.plur.enabled).toBe(true)
    expect(out).toContain('Opencode: config created')
    expect(out).not.toContain('not yet published')
    // #1338: say it was auto-detected, that the write is global, and how to skip it.
    expect(out).toMatch(/Opencode: config created \([^)]*\) \(auto-detected; global, applies to every opencode project; pass --no-opencode to skip\)/)
  })

  it('leaves opencode alone when its config dir does not exist', () => {
    const out = runInit()
    expect(existsSync(ocDir())).toBe(false)
    expect(out).toContain('Opencode: skipped')
    expect(out).not.toContain('not yet published')
  })

  it('--no-opencode skips it even when the config dir exists', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit(['--no-opencode'])
    expect(existsSync(ocJson())).toBe(false)
  })

  it('--opencode still forces it when no config dir exists', () => {
    const out = runInit(['--opencode'])
    expect(readOc().plugin).toEqual(['@plur-ai/opencode'])
    // #1338: forced, so not "auto-detected"; still global.
    expect(out).toContain('(global, applies to every opencode project)')
    expect(out).not.toContain('auto-detected')
  })

  it('--keep-opencode-plugin preserves an intentionally older pin', () => {
    mkdirSync(ocDir(), { recursive: true })
    writeFileSync(ocJson(), JSON.stringify({ plugin: ['@plur-ai/opencode@0.1.1'] }))
    const out = runInit(['--keep-opencode-plugin'])
    expect(readOc().plugin).toEqual(['@plur-ai/opencode@0.1.1'])
    expect(out).toContain('existing plugin pin kept')
  })

  it('a re-run is byte-for-byte idempotent', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit()
    const first = readFileSync(ocJson(), 'utf-8')
    const out = runInit()
    expect(readFileSync(ocJson(), 'utf-8')).toBe(first)
    expect(out).toContain('Opencode: config already up to date')
  })

  it('preserves an existing opencode.json and its unrelated keys', () => {
    mkdirSync(ocDir(), { recursive: true })
    writeFileSync(ocJson(), JSON.stringify({
      model: 'provider/some-model',
      plugin: ['some-other-plugin'],
      mcp: { other: { type: 'local', command: ['other-server'] } },
    }))
    runInit()
    const cfg = readOc()
    expect(cfg.model).toBe('provider/some-model')
    expect(cfg.plugin).toEqual(['some-other-plugin', '@plur-ai/opencode'])
    expect(cfg.mcp.other).toEqual({ type: 'local', command: ['other-server'] })
    expect(cfg.mcp.plur.type).toBe('local')
  })

  it('updates an opencode.jsonc while preserving comments and unrelated text', () => {
    mkdirSync(ocDir(), { recursive: true })
    const p = join(ocDir(), 'opencode.jsonc')
    const original = '{\n  // my comment\n  "model": "provider/some-model"\n}\n'
    writeFileSync(p, original)
    const out = runInit()
    const after = readFileSync(p, 'utf-8')
    expect(after).toContain('// my comment')
    expect(after).toContain('\"model\": \"provider/some-model\"')
    expect(existsSync(ocJson())).toBe(false)
    expect(out).toContain('Opencode: config updated')
  })

  it('uses the installed MCP command on darwin/linux', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit()
    const command: string[] = readOc().mcp.plur.command
    expect(command[0]).toBe(process.execPath)
    expect(command).toHaveLength(2)
    expect(existsSync(command[1])).toBe(true)
  })

  it('on win32 the MCP entry is node.exe + the @plur-ai/mcp js entry, never bare npx', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit([], true)
    const command: string[] = readOc().mcp.plur.command
    expect(command[0]).not.toBe('npx')
    expect(command[0]).toBe(process.execPath)
    expect(command).toHaveLength(2)
    expect(command[1]).toMatch(/index\.js$/)
    expect(existsSync(command[1])).toBe(true)
  })

  it('on win32 a re-run is idempotent too', () => {
    mkdirSync(ocDir(), { recursive: true })
    runInit([], true)
    const first = readFileSync(ocJson(), 'utf-8')
    runInit([], true)
    expect(readFileSync(ocJson(), 'utf-8')).toBe(first)
  })

  // Upgrades need zero manual steps: a Windows user who ran an older
  // `plur init --opencode` has the bare-npx entry that init wrote then.
  describe('win32 upgrade of the bare-npx entry an older init wrote', () => {
    const legacy = (extra: Record<string, unknown> = {}) => ({
      type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.20.0'], enabled: true, ...extra,
    })
    const seed = (plur: unknown) => {
      mkdirSync(ocDir(), { recursive: true })
      writeFileSync(ocJson(), JSON.stringify({ model: 'provider/some-model', plugin: ['@plur-ai/opencode'], mcp: { plur } }, null, 2))
    }

    it('replaces the command with node.exe + js entry and keeps every other field', () => {
      seed(legacy({ environment: { PLUR_PATH: '/some/store' }, timeout: 5000 }))
      const out = runInit([], true)
      const cfg = readOc()
      expect(cfg.mcp.plur.command[0]).toBe(process.execPath)
      expect(cfg.mcp.plur.command[1]).toMatch(/index\.js$/)
      expect(cfg.mcp.plur.type).toBe('local')
      expect(cfg.mcp.plur.enabled).toBe(true)
      expect(cfg.mcp.plur.environment).toEqual({ PLUR_PATH: '/some/store' })
      expect(cfg.mcp.plur.timeout).toBe(5000)
      expect(cfg.model).toBe('provider/some-model')
      expect(out).toContain('mcp.plur: upgraded')
      expect(out).not.toContain('left as-is')
    })

    it('a re-run after the upgrade changes nothing', () => {
      seed(legacy())
      runInit([], true)
      const first = readFileSync(ocJson(), 'utf-8')
      const out = runInit([], true)
      expect(readFileSync(ocJson(), 'utf-8')).toBe(first)
      expect(out).toContain('Opencode: config already up to date')
    })

    it.each([
      ['a custom launcher', { type: 'local', command: ['my-launcher'], enabled: true }],
      ['extra args after the package', legacy({ command: ['npx', '-y', '@plur-ai/mcp@0.20.0', '--flag'] })],
      ['another package', legacy({ command: ['npx', '-y', '@someone/mcp@0.20.0'] })],
      ['an unpinned package', legacy({ command: ['npx', '-y', '@plur-ai/mcp'] })],
      ['a remote entry', { type: 'remote', url: 'https://example.invalid/mcp', enabled: true }],
    ])('never touches %s', (_label, plur) => {
      seed(plur)
      runInit([], true)
      expect(readOc().mcp.plur).toEqual(plur)
    })

    it('migrates the owned bare-npx entry to installed MCP on darwin/linux', () => {
      seed(legacy())
      runInit()
      const command = readOc().mcp.plur.command
      expect(command[0]).toBe(process.execPath)
      expect(readOc().mcp.plur).toEqual({ ...legacy(), command })
    })
  })

  // A node-form entry this branch wrote goes stale after a Node upgrade or a
  // version-manager switch (the node path is version-specific), or when
  // @plur-ai/mcp moves. Re-running init repairs it, like #1270 does for the
  // Claude Code entry.
  describe('win32 repair of a stale node.exe entry PLUR wrote', () => {
    const current = (): string[] => { runInit([], true); return readOc().mcp.plur.command }
    const reseed = (plur: unknown) => {
      const cfg = readOc()
      cfg.mcp.plur = plur
      writeFileSync(ocJson(), JSON.stringify(cfg, null, 2))
    }
    const staleJs = '/old/prefix/node_modules/@plur-ai/mcp/dist/index.js'

    beforeEach(() => { mkdirSync(ocDir(), { recursive: true }) })

    it('repairs a node path that no longer exists, keeping other fields', () => {
      const [node, js] = current()
      reseed({ type: 'local', command: ['/gone/nodejs-22.1.0/node.exe', js], enabled: true, environment: { PLUR_PATH: '/some/store' } })
      const out = runInit([], true)
      const plur = readOc().mcp.plur
      expect(plur.command).toEqual([node, js])
      expect(plur.environment).toEqual({ PLUR_PATH: '/some/store' })
      expect(plur.enabled).toBe(true)
      expect(out).toContain('mcp.plur: repaired')
    })

    it('repairs a js entry that differs from the one resolved now', () => {
      const [node, js] = current()
      reseed({ type: 'local', command: [node, staleJs], enabled: true })
      runInit([], true)
      expect(readOc().mcp.plur.command).toEqual([node, js])
    })

    // Same rule as the Claude Code heal (#1270 review): a different node
    // binary that still exists is not stale. Rewriting it whenever another
    // install ran init would flip the entry between Node installs
    // (nvm-windows, Volta) on every run.
    it('leaves a node path alone that exists but is not the node running init', () => {
      const [, js] = current()
      const otherNode = join(home, 'other-node', 'node.exe')
      mkdirSync(join(home, 'other-node'), { recursive: true })
      writeFileSync(otherNode, '')
      reseed({ type: 'local', command: [otherNode, js], enabled: true })
      const before = readFileSync(ocJson(), 'utf-8')
      const out = runInit([], true)
      expect(readFileSync(ocJson(), 'utf-8')).toBe(before)
      expect(out).not.toContain('mcp.plur: repaired')
    })

    it('a current entry is left byte-for-byte alone', () => {
      current()
      const before = readFileSync(ocJson(), 'utf-8')
      const out = runInit([], true)
      expect(readFileSync(ocJson(), 'utf-8')).toBe(before)
      expect(out).not.toContain('mcp.plur: repaired')
    })

    it.each([
      ['another script', ['/gone/node.exe', '/my/own/server.js']],
      ['extra args', ['/gone/node.exe', staleJs, '--flag']],
      ['another launcher', ['/gone/bun.exe', staleJs]],
    ])('never touches %s', (_label, command) => {
      current()
      const plur = { type: 'local', command, enabled: true }
      reseed(plur)
      runInit([], true)
      expect(readOc().mcp.plur).toEqual(plur)
    })

    it('leaves a node.exe entry alone off win32', () => {
      const plur = { type: 'local', command: ['/gone/node.exe', staleJs], enabled: true }
      writeFileSync(ocJson(), JSON.stringify({ mcp: { plur } }))
      runInit()
      expect(readOc().mcp.plur).toEqual(plur)
    })
  })
})
