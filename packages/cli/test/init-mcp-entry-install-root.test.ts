/**
 * Security audit 2026-11-06: `plur init` locates @plur-ai/mcp to build the
 * plur-mcp shim and every harness's MCP entry. It used to walk up to 12
 * ancestors of the CLI and take the first @plur-ai/mcp it found, so for a
 * CLI-only global install (the CLI does not depend on mcp) a package planted
 * high up — e.g. C:\node_modules on Windows, 9 levels above
 * %APPDATA%\npm\node_modules\@plur-ai\cli\dist — became the MCP launch target.
 * Only the CLI's own install root may count.
 *
 * The built CLI is copied into a scratch Windows-like npm layout (POSIX paths)
 * and run with HOME and PLUR_PATH in a temp dir. The planted file is a dummy
 * that is never executed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, cpSync, symlinkSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { _resolveMcpEntrypoint } from '../src/commands/init.js'

const CLI = builtCliPath(join(__dirname, '..'))
const CLI_PKG = join(__dirname, '..')

let base: string, home: string, drive: string, npmModules: string, cliEntry: string

function plantMcp(nodeModules: string): string {
  const pkg = join(nodeModules, '@plur-ai', 'mcp')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@plur-ai/mcp', version: '0.0.0-dummy' }))
  writeFileSync(join(pkg, 'dist', 'index.js'), '// dummy, never executed\n')
  return join(pkg, 'dist', 'index.js')
}

const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

function init(): string {
  const r = runCli('node', [cliEntry, 'init', '--no-desktop', '--no-prompt', '--no-codex', '--no-cursor', '--no-antigravity', '--no-opencode'], {
    encoding: 'utf-8', cwd: home, input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'), PLUR_PATH: join(home, '.plur') },
  })
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout ?? ''
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-root-')))
  home = join(base, 'home'); mkdirSync(home); mkdirSync(join(base, 'tmp'))
  drive = join(base, 'C')
  npmModules = join(drive, 'Users', 'u', 'AppData', 'Roaming', 'npm', 'node_modules')
  const cli = join(npmModules, '@plur-ai', 'cli')
  mkdirSync(cli, { recursive: true })
  cpSync(dirname(CLI), join(cli, 'dist'), { recursive: true })
  cpSync(join(CLI_PKG, 'package.json'), join(cli, 'package.json'))
  symlinkSync(join(CLI_PKG, 'node_modules'), join(cli, 'node_modules'))
  cliEntry = join(cli, 'dist', 'index.js')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('plur init takes @plur-ai/mcp only from the CLI install root', () => {
  it('ignores an @plur-ai/mcp planted in a higher ancestor (drive-root analogue)', () => {
    const planted = plantMcp(join(drive, 'node_modules'))
    init()
    expect(text(join(home, '.plur', 'bin', 'plur-mcp.meta.json'))).not.toContain(planted)
    expect(text(join(home, '.plur', 'bin', 'plur-mcp'))).not.toContain(planted)
    expect(text(join(home, '.claude.json'))).not.toContain(planted)
  }, 60_000)

  it('still uses @plur-ai/mcp installed beside the CLI in the same node_modules', () => {
    const beside = plantMcp(npmModules)
    init()
    expect(JSON.parse(text(join(home, '.plur', 'bin', 'plur-mcp.meta.json'))).entrypoint).toBe(beside)
  }, 60_000)
})

describe('resolveMcpEntrypoint candidates', () => {
  it('pnpm layout: the store-level node_modules counts, nothing above it', () => {
    const nm = join(base, 'pnpm', 'global', '5', 'node_modules')
    const cliEntryPnpm = join(nm, '.pnpm', '@plur-ai+cli@0.0.0', 'node_modules', '@plur-ai', 'cli', 'dist', 'index.js')
    mkdirSync(dirname(cliEntryPnpm), { recursive: true })
    plantMcp(join(base, 'node_modules'))
    expect(_resolveMcpEntrypoint(cliEntryPnpm)).toBeNull()
    const ok = plantMcp(nm)
    expect(_resolveMcpEntrypoint(cliEntryPnpm)).toBe(ok)
  })

  it('monorepo workspace: packages/cli → packages/mcp', () => {
    const pkgs = join(base, 'repo', 'packages')
    const entry = join(pkgs, 'cli', 'dist', 'index.js')
    mkdirSync(dirname(entry), { recursive: true })
    mkdirSync(join(pkgs, 'mcp', 'dist'), { recursive: true })
    writeFileSync(join(pkgs, 'mcp', 'package.json'), JSON.stringify({ name: '@plur-ai/mcp' }))
    writeFileSync(join(pkgs, 'mcp', 'dist', 'index.js'), '')
    expect(_resolveMcpEntrypoint(entry)).toBe(join(pkgs, 'mcp', 'dist', 'index.js'))
  })
})
