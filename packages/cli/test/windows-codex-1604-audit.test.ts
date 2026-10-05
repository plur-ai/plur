/**
 * Audit round on PR #1604 (#1603).
 *
 * - M1: macOS and Linux keep main's behaviour. No Codex app-binary fallback,
 *   and doctor's `codexDetected` is "the Codex home exists", exactly as on main.
 * - L1: the cmd.exe line turns delayed expansion off (/v:off) and refuses `%`.
 * - L2: a pre-release never beats or ties its own release.
 * - L3: only the app release folder for this machine's architecture is used.
 * - L4: the proxy hint counts `--use-env-proxy` in NODE_OPTIONS or execArgv.
 * - L5: hook-command.ts's two cmd.exe lines go through the shared helper.
 * - Sibling: doctor's handshake resolves `npx` / a `.cmd` through the helper.
 * - Info: the TOML snippet escapes a newline; `plur ui` opens URLs the way
 *   `plur login` does (rundll32 url.dll,FileProtocolHandler), not `cmd /c start`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { commandSpawn, cmdExeSpawn } from '../src/lib/command-spawn.js'
import { resolveCodexBinary, codexInstalled, codexTomlSnippet } from '../src/lib/codex-binary.js'
import { claudeVersionOutput, resolveShortPath } from '../src/lib/hook-command.js'
import { embeddingNetworkHint } from '../src/commands/doctor.js'
import { urlOpener } from '../src/lib/open-url.js'


describe('L1: cmd.exe line', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1604-l1-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('turns delayed expansion off and refuses %', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    const spec = commandSpawn('codex', ['mcp', 'list'], 'win32', { PATH: dir })
    expect(spec.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    expect(() => commandSpawn('codex', ['C:\\Users\\a%OS%b\\x.js'], 'win32', { PATH: dir })).toThrow(/cannot be passed/)
    expect(() => commandSpawn('codex', ['50%'], 'win32', { PATH: dir })).toThrow(/cannot be passed/)
  })

  it('cmdExeSpawn is the one place the line is built', () => {
    expect(cmdExeSpawn('claude --version', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"claude --version"'],
      windowsVerbatimArguments: true,
    })
    expect(cmdExeSpawn('x', {}).file).toBe('cmd.exe')
  })
})

describe('sibling: commandSpawn resolves what an MCP config may name (doctor handshake)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1604-sib-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('runs an absolute .cmd path through cmd.exe', () => {
    const shim = join(dir, 'plur-mcp.cmd')
    writeFileSync(shim, '')
    const spec = commandSpawn(shim, [], 'win32', {})
    expect(spec.file).toBe('cmd.exe')
    expect(spec.args[4]).toBe(`""${shim}""`)
  })

  it('finds npx.cmd for a bare `npx`, and spawns an absolute .exe directly', () => {
    writeFileSync(join(dir, 'npx.cmd'), '')
    expect(commandSpawn('npx', ['-y', '@plur-ai/mcp@0.21.3'], 'win32', { PATH: dir }).args[4])
      .toBe(`""${join(dir, 'npx.cmd')}" "-y" "@plur-ai/mcp@0.21.3""`)
    const exe = join(dir, 'node.exe')
    writeFileSync(exe, '')
    expect(commandSpawn(exe, ['a.js'], 'win32', {})).toEqual({ file: exe, args: ['a.js'] })
  })
})

describe('L5: hook-command.ts cmd.exe lines keep their behaviour through the shared helper', () => {
  let dir: string
  let log: string
  let savedPath: string | undefined
  let savedComSpec: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-1604-l5-'))
    log = join(dir, 'args.log')
    savedPath = process.env.PATH
    savedComSpec = process.env.ComSpec
    delete process.env.ComSpec
    process.env.PATH = `${dir}${delimiter}${savedPath}`
  })
  afterEach(() => {
    process.env.PATH = savedPath
    if (savedComSpec !== undefined) process.env.ComSpec = savedComSpec
    rmSync(dir, { recursive: true, force: true })
  })

  const stubCmd = (answer: string) => writeFileSync(join(dir, 'cmd.exe'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho '${answer}'\n`, { mode: 0o755 })

  it('claudeVersionOutput runs `claude --version` through cmd.exe and returns its output', () => {
    stubCmd('2.1.200 (Claude Code)')
    expect(claudeVersionOutput('win32')).toContain('2.1.200')
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual(['/d', '/v:off', '/s', '/c', '"claude --version"'])
  })

  it('resolveShortPath asks cmd for %~sI and returns the answer', () => {
    stubCmd('C:\\PROGRA~1\\plur')
    expect(resolveShortPath('C:\\Program Files\\plur')).toBe('C:\\PROGRA~1\\plur')
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean))
      .toEqual(['/d', '/v:off', '/s', '/c', '"for %I in ("C:\\Program Files\\plur") do @echo %~sI"'])
  })
})

describe('codex-binary audit items', () => {
  let root: string
  let pathDir: string
  let codexHome: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-1604-bin-'))
    pathDir = join(root, 'bin')
    codexHome = join(root, '.codex')
    mkdirSync(pathDir)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const release = (name: string) => {
    const dir = join(codexHome, 'packages', 'app-server-daemon', 'releases', name, 'bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'codex.exe'), '')
    return join(dir, 'codex.exe')
  }
  const pick = (arch: string) => resolveCodexBinary({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', arch)?.path ?? null

  it('L2: a release beats its own pre-release', () => {
    const rel = release('0.160.0-x86_64-pc-windows-msvc')
    release('0.160.0-alpha.3-x86_64-pc-windows-msvc')
    expect(pick('x64')).toBe(rel)
  })

  it('L2: pre-release identifiers compare numerically', () => {
    release('0.161.0-alpha.2-x86_64-pc-windows-msvc')
    const ten = release('0.161.0-alpha.10-x86_64-pc-windows-msvc')
    expect(pick('x64')).toBe(ten)
  })

  it('L2: a pre-release of a newer version still beats an older release (semver)', () => {
    release('0.160.0-x86_64-pc-windows-msvc')
    const pre = release('0.161.0-alpha.1-x86_64-pc-windows-msvc')
    expect(pick('x64')).toBe(pre)
  })

  it('L3: picks the folder for this architecture and ignores others', () => {
    const arm = release('0.160.0-aarch64-pc-windows-msvc')
    const x86 = release('0.160.0-x86_64-pc-windows-msvc')
    release('0.170.0-aarch64-pc-windows-msvc')
    expect(pick('x64')).toBe(x86)
    expect(pick('arm64')).toBe(join(codexHome, 'packages', 'app-server-daemon', 'releases', '0.170.0-aarch64-pc-windows-msvc', 'bin', 'codex.exe'))
    rmSync(x86)
    expect(pick('x64')).toBeNull()
    expect(arm).toContain('aarch64')
  })

  it('M1: codexInstalled on darwin/linux is "the Codex home exists", as on main', () => {
    writeFileSync(join(pathDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'darwin', 'arm64')).toBe(false)
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'linux', 'x64')).toBe(false)
    mkdirSync(codexHome)
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'darwin', 'arm64')).toBe(true)
  })

  it('M1: on Windows a codex.cmd on PATH alone counts as installed', () => {
    writeFileSync(join(pathDir, 'codex.cmd'), '')
    expect(codexInstalled({ PATH: pathDir, CODEX_HOME: codexHome }, 'win32', 'x64')).toBe(true)
  })
})

describe('Info: codexTomlSnippet escapes a newline', () => {
  it('writes a value with a newline as a TOML basic string, one line per key', () => {
    const out = codexTomlSnippet({ command: '/opt/we\nird/node', args: ['/x/index.js'] })
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('    command = "/opt/we\\nird/node"')
    expect(lines[2]).toBe("    args = ['/x/index.js']")
  })

  it('keeps Windows paths as literal strings', () => {
    expect(codexTomlSnippet({ command: 'C:\\node\\node.exe', args: [] })).toContain("command = 'C:\\node\\node.exe'")
  })
})

describe('L4: proxy hint counts --use-env-proxy', () => {
  const env = { HTTPS_PROXY: 'http://proxy:8080' }
  it('in NODE_OPTIONS', () => {
    const text = embeddingNetworkHint('fetch failed', { ...env, NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, '24.10.0', []).join('\n')
    expect(text).not.toMatch(/ignore it/)
    expect(text).toMatch(/reachable/)
  })
  it('in execArgv', () => {
    const text = embeddingNetworkHint('fetch failed', env, '24.10.0', ['--use-env-proxy']).join('\n')
    expect(text).not.toMatch(/ignore it/)
    expect(text).toMatch(/reachable/)
  })
  it('still warns without either', () => {
    expect(embeddingNetworkHint('fetch failed', env, '24.10.0', []).join('\n')).toMatch(/ignore it/)
  })
})

describe('Info: plur ui opens a URL without cmd /c start', () => {
  it('uses rundll32 url.dll,FileProtocolHandler on Windows, as plur login does', () => {
    expect(urlOpener('http://127.0.0.1:7777/?a=1&b=2', 'win32')).toEqual(['rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:7777/?a=1&b=2']])
    expect(urlOpener('http://x', 'darwin')).toEqual(['open', ['http://x']])
    expect(urlOpener('http://x', 'linux')).toEqual(['xdg-open', ['http://x']])
  })
})
