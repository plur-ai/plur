/**
 * #1832, end to end: a real `plur init` from a (fake) global install, then an
 * in-place global upgrade to a newer version and `plur init` again. Every
 * tool config PLUR writes must launch the new version afterwards:
 *
 *   - Claude Code (~/.claude.json), the `--project` marker, Claude Desktop,
 *     Cursor, Antigravity, Codex and OpenCode;
 *   - with @plur-ai/mcp installed globally the configs launch the installed
 *     server (the shim, or node + the installed entry for OpenCode), which
 *     follows the upgrade at the same path without a re-pin;
 *   - with the CLI alone, each config records an exact npx pin, and the
 *     second init moves it to the new version (never `@latest`, #1069).
 *
 * The Codex leg already behaved this way before #1832 (codexLaunchKind); it
 * is here as a regression guard. Its registration is written into
 * config.toml up front, as `codex mcp add` would, so no `codex` binary is
 * needed.
 *
 * Real spawned CLI, temp HOME (isolatedHomeEnv); the fake global install is
 * this workspace's build copied under a temp prefix (fake-global-install.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { fakeGlobalInstall } from './helpers/fake-global-install.js'
import { readCodexEntry } from '../src/codex-config.js'
import { printText } from '../src/commands/doctor.js'

// Fails loudly on a stale workspace build, which the fake install copies.
const CLI = builtCliPath(join(__dirname, '..'))

const OLD = '0.22.9'
const NEW = '0.23.1'

let home: string
let prefix: string
let work: string
let env: NodeJS.ProcessEnv

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf8'))
const desktopPath = () => process.platform === 'darwin'
  ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  : join(home, '.config', 'Claude', 'claude_desktop_config.json')
const shim = () => join(home, '.plur', 'bin', 'plur-mcp')

function init(cli: string, ...extra: string[]): string {
  const r = runCli('node', [cli, 'init', '--no-prompt', '--desktop', '--cursor', '--codex', '--antigravity', '--opencode', ...extra], {
    encoding: 'utf-8', env, cwd: work, input: '', timeout: 120_000,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  expect(r.status, out).toBe(0)
  return out
}

const line = (e: { command: string; args?: string[] }) => [e.command, ...(e.args ?? [])].join(' ')

/** What each tool config launches, one line per writer. */
function launches(): Record<string, string> {
  return {
    claudeCode: line(read(join(home, '.claude.json')).mcpServers.plur),
    projectMarker: line(read(join(work, '.claude', 'settings.json')).mcpServers.plur),
    desktop: line(read(desktopPath()).mcpServers.plur),
    cursor: line(read(join(work, '.cursor', 'mcp.json')).mcpServers.plur),
    antigravity: line(read(join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.plur),
    codex: line(readCodexEntry(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'))!),
    opencode: read(join(home, '.config', 'opencode', 'opencode.json')).mcp.plur.command.join(' '),
  }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1832-')))
  prefix = join(home, 'prefix')
  work = join(home, 'work')
  mkdirSync(join(home, 'tmp'))
  mkdirSync(join(work, '.cursor'), { recursive: true })
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  // The registration `codex mcp add` makes; init edits it in place from here.
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.plur]\ncommand = "npx"\nargs = ["-y", "@plur-ai/mcp@${OLD}"]\n`)
  env = { ...isolatedHomeEnv(home), TMPDIR: join(home, 'tmp'), PLUR_DISABLE_EMBEDDINGS: '1' }
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('tool configs follow a global upgrade to latest (#1832)', { timeout: 300_000 }, () => {
  it('CLI only (no installed MCP): every npx pin moves from the old version to the new one', () => {
    const old = fakeGlobalInstall(prefix, { version: OLD, withMcp: false })
    init(old.cli)
    init(old.cli, '--project')
    for (const [writer, cmd] of Object.entries(launches())) expect(cmd, writer).toContain(`@plur-ai/mcp@${OLD}`)

    const upgraded = fakeGlobalInstall(prefix, { version: NEW, withMcp: false })
    const out = init(upgraded.cli)
    init(upgraded.cli, '--project')
    for (const [writer, cmd] of Object.entries(launches())) {
      expect(cmd, writer).toContain(`@plur-ai/mcp@${NEW}`)
      expect(cmd, writer).not.toContain(OLD)
      expect(cmd, writer).not.toContain('@latest')
    }
    expect(out).toContain(`updated the npx pin ${OLD} → ${NEW}`)
  })

  it('CLI and MCP installed: configs launch the installed server, which follows the upgrade with no re-pin', () => {
    const old = fakeGlobalInstall(prefix, { version: OLD, withMcp: true })
    init(old.cli)
    init(old.cli, '--project')
    const before = launches()
    for (const [writer, cmd] of Object.entries(before)) {
      if (writer === 'opencode') expect(cmd, writer).toBe(`${process.execPath} ${old.mcp}`)
      else expect(cmd, writer).toBe(shim())
    }
    const version = () => spawnSync(shim(), ['--version'], { encoding: 'utf-8', env }).stdout.trim()
    expect(version()).toBe(OLD)

    const upgraded = fakeGlobalInstall(prefix, { version: NEW, withMcp: true })
    // The upgrade alone already reaches the configs: same paths, new files.
    expect(version()).toBe(NEW)
    init(upgraded.cli)
    init(upgraded.cli, '--project')
    expect(launches()).toEqual(before)
  })

  it('pins from a CLI-only install move to the installed server once MCP is installed with the upgrade', () => {
    const old = fakeGlobalInstall(prefix, { version: OLD, withMcp: false })
    init(old.cli)
    init(old.cli, '--project')
    const upgraded = fakeGlobalInstall(prefix, { version: NEW, withMcp: true })
    init(upgraded.cli)
    init(upgraded.cli, '--project')
    for (const [writer, cmd] of Object.entries(launches())) {
      if (writer === 'opencode') expect(cmd, writer).toBe(`${process.execPath} ${upgraded.mcp}`)
      else expect(cmd, writer).toBe(shim())
    }
  })

  it('the Cursor note says to install the latest version globally', () => {
    const { cli } = fakeGlobalInstall(prefix, { version: NEW, withMcp: true })
    const out = init(cli)
    expect(out).toContain('install the latest version globally; tool configs record the exact version')
    expect(out).not.toContain('avoid @latest')
  })

  it('doctor\'s npx advice says to install the MCP package globally, then run plur init', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: { plur: { command: '/bin/sh', args: ['-lc', `exec npx -y @plur-ai/mcp@${OLD}`] } },
    }))
    // Piped, doctor answers in JSON; its text form is printText over that report.
    const r = runCli('node', [CLI, 'doctor', '--no-handshake', '--json'], { encoding: 'utf-8', env, cwd: work, timeout: 120_000 })
    const report = JSON.parse(r.stdout ?? '{}')
    expect(report.staleNpxMcp).toBe(true)
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { written.push(String(chunk)); return true })
    try { printText(report) } finally { spy.mockRestore() }
    const out = written.join('')
    expect(out).toContain('plur MCP still launched via npx')
    expect(out).toContain('npm i -g @plur-ai/cli@latest @plur-ai/mcp@latest), then run `plur init`')
  })
})
