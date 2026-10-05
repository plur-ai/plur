/**
 * #1603 — on Windows, npm installs Codex as `codex.cmd`. `execFileSync('codex')`
 * does not find it (no PATHEXT search for `.cmd` without a shell), so
 * `plur init --codex` reported "the codex binary is not on PATH" and never
 * registered the MCP server.
 *
 * The resolver and the spawn spec are unit-tested with a mocked platform and
 * PATH. The spawned-CLI tests use the win32 platform preload with a stub
 * `codex.cmd` on PATH and a stand-in `cmd.exe` that records the command line
 * it was given — real cmd.exe parsing is covered by the Windows CI job
 * (scripts/windows-codex-probe.mjs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { findWindowsCommand, commandSpawn } from '../src/lib/command-spawn.js'
import { resolveCodexBinary, codexInstalled } from '../src/lib/codex-binary.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

describe('findWindowsCommand: PATH + PATHEXT (#1603)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1603-path-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('finds an npm-installed codex.cmd', () => {
    writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\n')
    expect(findWindowsCommand('codex', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toBe(join(dir, 'codex.cmd'))
  })

  it('follows PATHEXT order within a directory and PATH order across directories', () => {
    const second = join(dir, 'second')
    mkdirSync(second)
    writeFileSync(join(dir, 'codex.cmd'), '')
    writeFileSync(join(dir, 'codex.exe'), '')
    writeFileSync(join(second, 'codex.exe'), '')
    expect(findWindowsCommand('codex', { PATH: [dir, second].join(delimiter), PATHEXT: '.EXE;.CMD' })).toBe(join(dir, 'codex.exe'))
  })

  it('reads Path/PathExt case-insensitively and defaults PATHEXT', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    expect(findWindowsCommand('codex', { Path: dir })).toBe(join(dir, 'codex.cmd'))
  })

  it('returns null when nothing matches', () => {
    expect(findWindowsCommand('codex', { PATH: dir })).toBeNull()
  })
})

describe('commandSpawn (#1603)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur 1603 spawn-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('runs a .cmd through cmd.exe /d /s /c with every argument quoted, verbatim', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
    const spec = commandSpawn('codex', ['mcp', 'add', 'plur', '--', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\a&b (x)\\index.js', 'C:\\dir\\'], 'win32', env)
    expect(spec.file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(spec.windowsVerbatimArguments).toBe(true)
    expect(spec.args).toEqual([
      '/d', '/v:off', '/s', '/c',
      `""${join(dir, 'codex.cmd')}" "mcp" "add" "plur" "--" "C:\\Program Files\\nodejs\\node.exe" "C:\\a&b (x)\\index.js" "C:\\dir\\\\""`,
    ])
  })

  it('defaults to process.platform', () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      writeFileSync(join(dir, 'codex.cmd'), '')
      const spec = commandSpawn('codex', ['mcp', 'list'], undefined, { PATH: dir })
      expect(spec.file).toBe('cmd.exe')
      expect(spec.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real })
    }
  })

  it('spawns a resolved .exe directly', () => {
    writeFileSync(join(dir, 'codex.exe'), '')
    expect(commandSpawn('codex', ['mcp', 'list'], 'win32', { PATH: dir })).toEqual({ file: join(dir, 'codex.exe'), args: ['mcp', 'list'] })
  })

  it('refuses an argument cmd.exe cannot carry safely', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    expect(() => commandSpawn('codex', ['say "hi"'], 'win32', { PATH: dir })).toThrow(/cannot be passed/)
  })

  it('leaves darwin/linux and an unresolved win32 name unchanged', () => {
    expect(commandSpawn('codex', ['mcp', 'list'], 'darwin', { PATH: dir })).toEqual({ file: 'codex', args: ['mcp', 'list'] })
    expect(commandSpawn('codex', ['mcp', 'list'], 'win32', { PATH: dir })).toEqual({ file: 'codex', args: ['mcp', 'list'] })
  })
})

/**
 * Field evidence (#1603): on the reporting machine `where codex` listed npm's
 * extensionless sh shim and `codex.cmd`; the Codex app's own binary, not on
 * PATH, lives at ~/.codex/packages/app-server-daemon/releases/<ver>-<triple>/bin/codex.exe
 * and registered plur with `mcp add plur -- node.exe <mcp dist/index.js>`.
 */
describe('resolveCodexBinary (#1603)', () => {
  let root: string
  let pathDir: string
  let codexHome: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-1603-resolve-'))
    pathDir = join(root, 'npm')
    codexHome = join(root, '.codex')
    mkdirSync(pathDir)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const appRelease = (release: string, exe = 'codex.exe') => {
    const dir = join(codexHome, 'packages', 'app-server-daemon', 'releases', release, 'bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, exe), '')
    return join(dir, exe)
  }

  it('picks codex.cmd over npm\'s extensionless sh shim on PATH', () => {
    writeFileSync(join(pathDir, 'codex'), '#!/bin/sh\n')
    writeFileSync(join(pathDir, 'codex.cmd'), '@echo off\r\n')
    expect(resolveCodexBinary({ PATH: pathDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', CODEX_HOME: codexHome }, 'win32', 'x64'))
      .toEqual({ path: join(pathDir, 'codex.cmd'), source: 'path' })
  })

  it('never uses the extensionless shim alone', () => {
    writeFileSync(join(pathDir, 'codex'), '#!/bin/sh\n')
    expect(resolveCodexBinary({ PATH: pathDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', CODEX_HOME: codexHome }, 'win32', 'x64')).toBeNull()
  })

  it('falls back to the Codex app\'s bundled codex.exe when none is on PATH', () => {
    const exe = appRelease('0.160.0-x86_64-pc-windows-msvc')
    expect(resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toEqual({ path: exe, source: 'app' })
  })

  it('chooses the newest app release by version, not by name', () => {
    appRelease('0.99.0-x86_64-pc-windows-msvc')
    const newest = appRelease('0.160.0-x86_64-pc-windows-msvc')
    appRelease('0.159.2-x86_64-pc-windows-msvc')
    mkdirSync(join(codexHome, 'packages', 'app-server-daemon', 'releases', '0.200.0-x86_64-pc-windows-msvc')) // no bin
    expect(resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toEqual({ path: newest, source: 'app' })
  })

  it('prefers a codex on PATH over the app binary', () => {
    appRelease('0.160.0-x86_64-pc-windows-msvc')
    writeFileSync(join(pathDir, 'codex.cmd'), '')
    expect(resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')?.source).toBe('path')
  })

  it('on darwin/linux, finds an executable codex on PATH and never the app binary (audit M1)', () => {
    appRelease('0.160.0-aarch64-apple-darwin', 'codex')
    expect(resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'darwin', 'arm64')).toBeNull()
    writeFileSync(join(pathDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    expect(resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'darwin', 'arm64')).toEqual({ path: join(pathDir, 'codex'), source: 'path' })
  })

  it('returns null when Codex is nowhere', () => {
    expect(resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toBeNull()
  })

  it('codexInstalled (doctor): a Codex home, a codex on PATH, or neither', () => {
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toBe(false)
    writeFileSync(join(pathDir, 'codex.cmd'), '')
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toBe(true)
    rmSync(join(pathDir, 'codex.cmd'))
    appRelease('0.160.0-x86_64-pc-windows-msvc')
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toBe(true)
  })
})

describe('plur init --codex with an npm codex.cmd on PATH (#1603, win32 preload)', { timeout: 90000 }, () => {
  let home: string
  let bin: string
  let log: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-1603-'))
    bin = join(home, 'fakebin')
    mkdirSync(bin)
    log = join(home, 'cmd.log')
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function run(pathDirs: string[]): string {
    try {
      return execFileSync(process.execPath, ['--import', WIN32_PRELOAD, CLI,
        'init', '--global', '--no-desktop', '--no-cursor', '--no-antigravity', '--no-opencode', '--codex', '--no-prompt'], {
        encoding: 'utf-8', timeout: 60000, cwd: home,
        env: { ...isolatedHomeEnv(home), PATH: pathDirs.join(delimiter), ComSpec: '' },
      })
    } catch (err: any) { return `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }

  it('registers plur through cmd.exe + codex.cmd, with node (not a .cmd) as the server command', () => {
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\n')
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho "sh shim must not run" >&2\nexit 7\n', { mode: 0o755 })
    // Stand-in cmd.exe: records the /c command line (its last argument); answers nothing.
    writeFileSync(join(bin, 'cmd.exe'), `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s\\n' "$last" >> "${log}"\nexit 0\n`, { mode: 0o755 })
    const out = run([bin, '/usr/bin', '/bin'])
    expect(out).toContain('MCP server: registered via `codex mcp add`')
    expect(out).toContain(`(${join(bin, 'codex.cmd')})`)
    const lines = existsSync(log) ? readFileSync(log, 'utf-8').split('\n') : []
    const cmdShim = `"${join(bin, 'codex.cmd')}"`
    expect(lines.some(l => l.startsWith(`"${cmdShim} "mcp" "list"`))).toBe(true)
    const add = lines.find(l => l.startsWith(`"${cmdShim} "mcp" "add" "plur" "--"`))
    expect(add).toBeDefined()
    expect(add).toContain(`"--" "${process.execPath}" "`)
    expect(add).not.toMatch(/\.cmd" "[^"]*"$/)
  })

  it('falls back to the Codex app\'s bundled codex.exe when no codex is on PATH, and names it', () => {
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const appBin = join(home, '.codex', 'packages', 'app-server-daemon', 'releases', `0.160.0-${triple}`, 'bin')
    mkdirSync(appBin, { recursive: true })
    const appLog = join(home, 'app.log')
    writeFileSync(join(appBin, 'codex.exe'), `#!/bin/sh\necho "$*" >> "${appLog}"\nexit 0\n`, { mode: 0o755 })
    const out = run([bin, '/usr/bin', '/bin'])
    expect(out).toContain('MCP server: registered via `codex mcp add`')
    expect(out).toContain(join(appBin, 'codex.exe'))
    const calls = existsSync(appLog) ? readFileSync(appLog, 'utf-8') : ''
    expect(calls).toContain('mcp list')
    expect(calls).toContain(`mcp add plur -- ${process.execPath} `)
  })

  it('still says Codex is absent, and prints the TOML to add by hand', () => {
    const out = run([bin, '/usr/bin', '/bin'])
    expect(out).toContain('no `codex` on PATH and no Codex app binary')
    expect(out).toContain('[mcp_servers.plur]')
    expect(out).toContain(`command = '${process.execPath}'`)
    expect(out).toMatch(/args = \['[^']+'\]/)
  })
})
