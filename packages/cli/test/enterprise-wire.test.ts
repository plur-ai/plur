import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, statSync, chmodSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser'
import { parseJsonc } from '../src/lib/jsonc.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import type { ExecFn } from '../src/enterprise/exec.js'
import {
  applyMcpEnv,
  toolLaunch,
  launchProblem,
  wslSide,
  probeWsl,
  wireTools,
  runPlurInit,
  OTHER_SIDE_TEXT,
  PLUR_ENV_KEYS,
  type WslProbes,
  type WireResult,
} from '../src/enterprise/wire.js'

// Every config here lives in a temporary HOME; the real ~/.claude.json,
// ~/.codex and ~/.config/opencode are never read or written.

let home: string
let loc: { home: string; env: NodeJS.ProcessEnv }

const CA = '/h/.plur/company-ca.pem'
const PROXY = 'http://proxy.example.com:3128'
const THREE = { NODE_EXTRA_CA_CERTS: CA, HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1' }

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-wire-')))
  loc = { home, env: isolatedHomeEnv(home) }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function put(rel: string, text: string): string {
  const p = join(home, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
  return p
}

const toml = (text: string) => getStaticTOMLValue(parseTOML(text, { tomlVersion: '1.0' })) as any

const launchOf = (r: WireResult) => (r.status === 'wired' ? r.launch : undefined)

const NO_PROBES: WslProbes = { codexOnPath: true, codexInWsl: false, isWsl: false, codexOnWindows: false }

// ─── Codex ────────────────────────────────────────────────────────────────────

describe('applyMcpEnv: codex', () => {
  const OTHER = '# my other server\n[mcp_servers.other]\ncommand = "other-cmd"\nargs = ["--x"]\n'
  const PLUR = '[mcp_servers.plur]\ncommand = "/h/.plur/bin/plur-mcp"\nargs = []\n'

  it('writes exactly the three keys into [mcp_servers.plur.env] and leaves [mcp_servers.other] byte-identical', () => {
    const path = put('.codex/config.toml', OTHER + '\n' + PLUR)
    const r = applyMcpEnv('codex', THREE, loc)
    expect(r).toMatchObject({ status: 'updated', path })
    const after = readFileSync(path, 'utf8')
    expect(after.startsWith(OTHER)).toBe(true)
    const data = toml(after)
    expect(data.mcp_servers.plur.env).toEqual(THREE)
    expect(data.mcp_servers.other).toEqual({ command: 'other-cmd', args: ['--x'] })
  })

  it('the launch takes the proxy from the entry, not the parent, and drops what Codex does not pass on', () => {
    put('.codex/config.toml', OTHER + '\n' + PLUR)
    applyMcpEnv('codex', THREE, loc)
    const launch = toolLaunch('codex', { HTTPS_PROXY: 'x', SECRET: 'y', PATH: '/bin' }, { ...loc, platform: 'linux' })
    expect(launch).not.toBeNull()
    expect(launch!.command).toBe('/h/.plur/bin/plur-mcp')
    expect(launch!.env.HTTPS_PROXY).toBe(PROXY)
    expect(launch!.env.NODE_EXTRA_CA_CERTS).toBe(CA)
    expect(launch!.env.SECRET).toBeUndefined()
    expect(launch!.env.PATH).toBe('/bin')
  })

  it('a second run with the same env is unchanged and does not touch the bytes', () => {
    const path = put('.codex/config.toml', PLUR)
    applyMcpEnv('codex', THREE, loc)
    const first = readFileSync(path, 'utf8')
    expect(applyMcpEnv('codex', THREE, loc).status).toBe('unchanged')
    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it('keeps the user\'s own env keys and comments, removes a PLUR key that is now absent', () => {
    const path = put('.codex/config.toml',
      PLUR + '\n[mcp_servers.plur.env]\n# where my memory lives\nPLUR_PATH = "/data/plur"\nHTTPS_PROXY = "http://old.example.com:8080"\nNODE_USE_ENV_PROXY = "1"\n')
    const r = applyMcpEnv('codex', { NODE_EXTRA_CA_CERTS: CA }, loc)
    expect(r.status).toBe('updated')
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('# where my memory lives')
    expect(toml(after).mcp_servers.plur.env).toEqual({ PLUR_PATH: '/data/plur', NODE_EXTRA_CA_CERTS: CA })
  })

  it('edits an inline env table', () => {
    const path = put('.codex/config.toml', '[mcp_servers.plur]\ncommand = "plur-mcp"\nenv = { PLUR_PATH = "/data/plur" }\n')
    expect(applyMcpEnv('codex', THREE, loc).status).toBe('updated')
    expect(toml(readFileSync(path, 'utf8')).mcp_servers.plur.env).toEqual({ PLUR_PATH: '/data/plur', ...THREE })
  })

  it('edits dotted env keys in place', () => {
    const path = put('.codex/config.toml', '[mcp_servers.plur]\ncommand = "plur-mcp"\nenv.PLUR_PATH = "/data/plur"\nenv.HTTPS_PROXY = "http://old.example.com:1"\n')
    expect(applyMcpEnv('codex', { NODE_EXTRA_CA_CERTS: CA }, loc).status).toBe('updated')
    expect(toml(readFileSync(path, 'utf8')).mcp_servers.plur.env).toEqual({ PLUR_PATH: '/data/plur', NODE_EXTRA_CA_CERTS: CA })
  })

  it('removing a key keeps the comment on its line', () => {
    const path = put('.codex/config.toml', '[mcp_servers.plur]\ncommand = "plur-mcp"\n[mcp_servers.plur.env]\nHTTPS_PROXY = "http://old.example.com:1" # my proxy note\nPLUR_PATH = "/data/plur"\n')
    expect(applyMcpEnv('codex', {}, loc).status).toBe('updated')
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('# my proxy note')
    expect(toml(after).mcp_servers.plur.env).toEqual({ PLUR_PATH: '/data/plur' })
  })

  it('dotted env keys inside an inline plur table can be added and removed', () => {
    const path = put('.codex/config.toml', '# mine\nmcp_servers.plur = { command = "plur-mcp", env.HTTPS_PROXY = "http://old.example.com:1", env.PLUR_PATH = "/data/plur" }\n[mcp_servers.other]\ncommand = "y"\n')
    expect(applyMcpEnv('codex', { NODE_EXTRA_CA_CERTS: CA }, loc).status).toBe('updated')
    const after = readFileSync(path, 'utf8')
    expect(toml(after).mcp_servers.plur.env).toEqual({ PLUR_PATH: '/data/plur', NODE_EXTRA_CA_CERTS: CA })
    expect(toml(after).mcp_servers.other).toEqual({ command: 'y' })
    expect(after).toContain('# mine')
  })

  it('an entry with a url is remote even when a command is left in it: refused, no launch', () => {
    const text = '[mcp_servers.plur]\ncommand = "plur-mcp"\nurl = "https://plur.example.com/mcp"\n'
    const path = put('.codex/config.toml', text)
    expect(applyMcpEnv('codex', THREE, loc)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/remote/) })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('a config.toml that does not parse is refused and left byte-identical', () => {
    const bad = '[mcp_servers.plur\ncommand = "x"\n'
    const path = put('.codex/config.toml', bad)
    expect(applyMcpEnv('codex', THREE, loc).status).toBe('refused')
    expect(readFileSync(path, 'utf8')).toBe(bad)
  })

  it('no plur entry, or no file, is absent', () => {
    expect(applyMcpEnv('codex', THREE, loc).status).toBe('absent')
    put('.codex/config.toml', OTHER)
    expect(applyMcpEnv('codex', THREE, loc).status).toBe('absent')
  })
})

// ─── OpenCode ─────────────────────────────────────────────────────────────────

describe('applyMcpEnv: opencode', () => {
  const JSONC = '{\n  // keep me\n  "mcp": {\n    "plur": { "type": "local", "command": ["/h/.plur/bin/plur-mcp"], "enabled": true }\n  }\n}\n'

  it('keeps comments and sets mcp.plur.environment', () => {
    const path = put('.config/opencode/opencode.jsonc', JSONC)
    expect(applyMcpEnv('opencode', THREE, loc)).toMatchObject({ status: 'updated', path })
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('// keep me')
    expect((parseJsonc(after) as any).mcp.plur.environment).toEqual(THREE)
  })

  it('removing a key keeps the comments around it', () => {
    const path = put('.config/opencode/opencode.jsonc', '{\n  "mcp": {\n    "plur": {\n      "type": "local",\n      "command": ["plur-mcp"],\n      "environment": {\n        "HTTP_PROXY": "http://old.example.com:1", // proxy note\n        // explanation of my storage location\n        "PLUR_PATH": "/data"\n      }\n    }\n  }\n}\n')
    expect(applyMcpEnv('opencode', {}, loc).status).toBe('updated')
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('// explanation of my storage location')
    expect(after).toContain('// proxy note')
    expect((parseJsonc(after) as any).mcp.plur.environment).toEqual({ PLUR_PATH: '/data' })
  })

  it('a symlinked opencode.json survives; the target file carries the env', () => {
    const target = put('dotfiles/opencode.json', JSONC.replace('  // keep me\n', ''))
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    const link = join(home, '.config', 'opencode', 'opencode.json')
    symlinkSync(target, link)
    expect(applyMcpEnv('opencode', THREE, loc).status).toBe('updated')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect((parseJsonc(readFileSync(target, 'utf8')) as any).mcp.plur.environment).toEqual(THREE)
  })

  it('the launch is the command array plus the entry environment', () => {
    put('.config/opencode/opencode.jsonc', JSONC)
    applyMcpEnv('opencode', THREE, loc)
    const launch = toolLaunch('opencode', { PATH: '/bin', HTTPS_PROXY: 'parent' }, loc)
    expect(launch).toEqual({ command: '/h/.plur/bin/plur-mcp', args: [], env: { PATH: '/bin', ...THREE } })
  })
})

// ─── Claude Code and Cursor ───────────────────────────────────────────────────

describe('applyMcpEnv: claude-code and cursor', () => {
  it('sets plur.env, leaves other servers alone, and a second run with {} removes only the PLUR keys', () => {
    const path = put('.claude.json', JSON.stringify({
      numStartups: 3,
      mcpServers: {
        other: { command: 'other-cmd', args: [], env: { HTTPS_PROXY: 'keep-other' } },
        plur: { command: '/h/.plur/bin/plur-mcp', args: [], env: { PLUR_PATH: '/data/plur' } },
      },
    }, null, 2))
    expect(applyMcpEnv('claude-code', THREE, loc).status).toBe('updated')
    let cfg = JSON.parse(readFileSync(path, 'utf8'))
    expect(cfg.mcpServers.plur.env).toEqual({ PLUR_PATH: '/data/plur', ...THREE })
    expect(cfg.mcpServers.other).toEqual({ command: 'other-cmd', args: [], env: { HTTPS_PROXY: 'keep-other' } })
    expect(cfg.numStartups).toBe(3)

    expect(applyMcpEnv('claude-code', {}, loc).status).toBe('updated')
    cfg = JSON.parse(readFileSync(path, 'utf8'))
    expect(cfg.mcpServers.plur.env).toEqual({ PLUR_PATH: '/data/plur' })
    expect(cfg.mcpServers.other.env).toEqual({ HTTPS_PROXY: 'keep-other' })
    expect(applyMcpEnv('claude-code', {}, loc).status).toBe('unchanged')
  })

  it('a broken ~/.cursor/mcp.json is refused and its bytes are unchanged', () => {
    const path = put('.cursor/mcp.json', '{ nope')
    expect(applyMcpEnv('cursor', THREE, loc)).toMatchObject({ status: 'refused', path })
    expect(readFileSync(path, 'utf8')).toBe('{ nope')
  })

  it('a remote (url) plur entry takes no launch env: refused, nothing written', () => {
    const text = JSON.stringify({ mcpServers: { plur: { type: 'http', url: 'https://plur.example.com/mcp' } } })
    const path = put('.claude.json', text)
    expect(applyMcpEnv('claude-code', THREE, loc)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/remote/) })
    expect(readFileSync(path, 'utf8')).toBe(text)
    const oc = JSON.stringify({ mcp: { plur: { type: 'remote', url: 'https://plur.example.com/mcp' } } })
    const ocPath = put('.config/opencode/opencode.json', oc)
    expect(applyMcpEnv('opencode', THREE, loc).status).toBe('refused')
    expect(readFileSync(ocPath, 'utf8')).toBe(oc)
  })

  it('a remote entry with a leftover command is still remote: refused, and no launch is read', () => {
    const text = JSON.stringify({ mcpServers: { plur: { type: 'http', url: 'https://plur.example.com/mcp', command: 'plur-mcp' } } })
    const path = put('.claude.json', text)
    expect(applyMcpEnv('claude-code', THREE, loc)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/remote/) })
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(toolLaunch('claude-code', {}, loc)).toBeNull()
    const oc = JSON.stringify({ mcp: { plur: { type: 'remote', url: 'https://plur.example.com/mcp', command: ['plur-mcp'] } } })
    const ocPath = put('.config/opencode/opencode.json', oc)
    expect(applyMcpEnv('opencode', THREE, loc).status).toBe('refused')
    expect(readFileSync(ocPath, 'utf8')).toBe(oc)
    expect(toolLaunch('opencode', {}, loc)).toBeNull()
  })

  it('a key outside the PLUR set is refused, nothing written', () => {
    const text = JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } })
    const path = put('.cursor/mcp.json', text)
    expect(applyMcpEnv('cursor', { PLUR_API_KEY: 'plur_sk_fake_never_written' }, loc).status).toBe('refused')
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('a proxy with a user name or password, or a value with a line break, is refused, nothing written', () => {
    const text = JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } })
    const path = put('.claude.json', text)
    const toml = '[mcp_servers.plur]\ncommand = "plur-mcp"\n'
    const codexPath = put('.codex/config.toml', toml)
    for (const env of <Array<Record<string, string>>>[
      { HTTPS_PROXY: 'http://alice:s3cret@proxy.example.com:3128', NODE_USE_ENV_PROXY: '1' },
      { HTTP_PROXY: 'http://alice@proxy.example.com:3128', NODE_USE_ENV_PROXY: '1' },
      { NO_PROXY: 'localhost\n[mcp_servers.evil]' },
      { NODE_EXTRA_CA_CERTS: '/h/ca.pem\r\nX=1' },
    ]) {
      const r = applyMcpEnv('claude-code', env, loc)
      expect(r.status).toBe('refused')
      expect(r.detail ?? '').not.toContain('s3cret')
      expect(applyMcpEnv('codex', env, loc).status).toBe('refused')
    }
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(readFileSync(codexPath, 'utf8')).toBe(toml)
  })

  it('keeps the file mode (a 0600 ~/.claude.json stays 0600)', () => {
    if (process.platform === 'win32') return
    const path = put('.claude.json', JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }))
    chmodSync(path, 0o600)
    applyMcpEnv('claude-code', THREE, loc)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('removes only keys in PLUR_ENV_KEYS', () => {
    expect([...PLUR_ENV_KEYS].sort()).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NO_PROXY'])
  })
})

// ─── Which launches hello may use ─────────────────────────────────────────────

describe('launchProblem', () => {
  const env = {}
  it('a direct launch has no problem', () => {
    expect(launchProblem('Codex', { command: '/usr/bin/node', args: ['/x/@plur-ai/mcp/dist/index.js'], env }, 'linux')).toBeNull()
    expect(launchProblem('Codex', { command: 'C:\\nodejs\\node.exe', args: ['C:\\x\\index.js'], env }, 'win32')).toBeNull()
    expect(launchProblem('Claude Code', { command: '/h/.plur/bin/plur-mcp', args: [], env }, 'darwin')).toBeNull()
  })
  it('npx, cmd.exe, a shell or a .cmd launcher is named, never handed to the proof', () => {
    expect(launchProblem('OpenCode', { command: 'npx', args: ['-y', '@plur-ai/mcp@0.22.0'], env }, 'linux')).toMatch(/OpenCode starts PLUR through npx/)
    expect(launchProblem('Codex', { command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp'], env }, 'win32')).toMatch(/through npx/)
    expect(launchProblem('Codex', { command: 'cmd.exe', args: ['/c', 'plur-mcp'], env }, 'win32')).toMatch(/through cmd/)
    expect(launchProblem('Cursor', { command: '/bin/sh', args: ['-lc', 'exec plur-mcp'], env }, 'darwin')).toMatch(/through sh/)
    expect(launchProblem('Codex', { command: 'C:\\Users\\a\\.plur\\bin\\plur-mcp.cmd', args: [], env }, 'win32')).toMatch(/\.cmd/)
    expect(launchProblem('Codex', { command: '/usr/bin/env', args: ['bash', '-c', 'plur-mcp'], env }, 'linux')).toMatch(/through bash/)
    expect(launchProblem('Codex', { command: '/usr/bin/env', args: ['-S', 'NODE_OPTIONS=x', 'sh', '-c', 'plur-mcp'], env }, 'linux')).toMatch(/through sh/)
    for (const command of ['bunx', 'pnpx', 'pnpm', 'yarn', 'uvx', 'C:\\Windows\\System32\\wsl.exe', 'busybox']) {
      expect(launchProblem('Codex', { command, args: ['@plur-ai/mcp'], env }, 'win32')).toMatch(/starts PLUR through/)
    }
    // Only PLUR itself is direct; an `env` prefix is not looked behind for that.
    expect(launchProblem('Codex', { command: '/usr/bin/env', args: ['/usr/bin/node', '/x/index.js'], env }, 'linux')).toMatch(/through env/)
  })
})

describe('launchProblem: only PLUR itself is a direct launch', () => {
  const env = {}
  it('a wrapper in any spelling is named', () => {
    for (const [command, args] of [
      ['/usr/bin/env', ['-u', 'DEBUG', 'bash', '-c', 'plur-mcp']],
      ['/usr/bin/env', ["-S", 'sh -c "plur-mcp"']],
      ['bun', ['x', '@plur-ai/mcp']],
      ['/usr/bin/node', ['/usr/lib/node_modules/npm/bin/npx-cli.js', '-y', '@plur-ai/mcp']],
      ['/usr/bin/node', ['-e', 'require("child_process").spawn("plur-mcp")']],
      ['/usr/bin/python3', ['-m', 'something']],
    ] as Array<[string, string[]]>) {
      expect(launchProblem('Codex', { command, args, env }, 'linux'), `${command} ${args.join(' ')}`).not.toBeNull()
    }
  })
  it('PLUR itself is direct', () => {
    expect(launchProblem('Codex', { command: '/h/.plur/bin/plur-mcp', args: [], env }, 'linux')).toBeNull()
    expect(launchProblem('Codex', { command: 'C:\\h\\.plur\\bin\\plur-mcp.exe', args: [], env }, 'win32')).toBeNull()
    expect(launchProblem('Codex', { command: '/usr/local/bin/node', args: ['/usr/local/lib/node_modules/@plur-ai/mcp/dist/index.js'], env }, 'darwin')).toBeNull()
  })
  it('wireTools hands no launch out for such an entry', async () => {
    put('.claude.json', JSON.stringify({ mcpServers: { plur: { command: 'bun', args: ['x', '@plur-ai/mcp'] } } }))
    const [claude] = await wireTools({ mcpEnv: THREE, ...loc, platform: 'linux', parentEnv: {}, probes: NO_PROBES })
    expect(claude.status).toBe('wired')
    expect(launchOf(claude)).toBeUndefined()
    expect(claude.detail).toMatch(/bun/)
  })
})

// ─── Windows and WSL ──────────────────────────────────────────────────────────

describe('wslSide', () => {
  it('follows the plan', () => {
    expect(wslSide('win32', { codexOnPath: false, codexInWsl: true, isWsl: false, codexOnWindows: false })).toBe('wsl')
    expect(wslSide('linux', { codexOnPath: false, codexInWsl: false, isWsl: true, codexOnWindows: true })).toBe('windows')
  })
  it('Codex here wins; nothing found is absent', () => {
    expect(wslSide('win32', { codexOnPath: true, codexInWsl: true, isWsl: false, codexOnWindows: false })).toBe('here')
    expect(wslSide('linux', { codexOnPath: true, codexInWsl: false, isWsl: true, codexOnWindows: true })).toBe('here')
    expect(wslSide('linux', { codexOnPath: false, codexInWsl: false, isWsl: false, codexOnWindows: true })).toBe('absent')
    expect(wslSide('darwin', { codexOnPath: false, codexInWsl: true, isWsl: true, codexOnWindows: true })).toBe('absent')
  })
  it('the wording names the side', () => {
    expect(OTHER_SIDE_TEXT.wsl).toBe('runs in WSL — run the installer inside WSL')
    expect(OTHER_SIDE_TEXT.windows).toBe('runs on Windows — run the installer in PowerShell')
  })
})

describe('probeWsl', () => {
  function recordingExec(stdout: string, status = 0): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
    const calls: Array<{ cmd: string; args: string[] }> = []
    return { calls, exec: (cmd, args) => { calls.push({ cmd, args }); return { status, stdout } } }
  }

  it('Windows: asks WSL through the System32 wsl.exe by absolute path', () => {
    const { exec, calls } = recordingExec('/home/alice/.npm-global/bin/codex\n')
    const p = probeWsl({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: '' }, osRelease: '10.0.22631', exec })
    expect(p.codexInWsl).toBe(true)
    expect(p.codexOnPath).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('C:\\Windows\\System32\\wsl.exe')
  })

  it('Windows: a SystemRoot that is not <drive>:\\Windows runs nothing', () => {
    for (const SystemRoot of ['\\\\evil.example.com\\share', 'C:\\Users\\alice\\Windows', 'C:\\Windows\\..\\Temp', undefined]) {
      const { exec, calls } = recordingExec('/usr/bin/codex\n')
      const p = probeWsl({ platform: 'win32', env: { SystemRoot, PATH: '' }, osRelease: '10.0.22631', exec })
      expect(p.codexInWsl).toBe(false)
      expect(calls).toHaveLength(0)
    }
  })

  it('Windows: an answer that is not a path, or a failed wsl.exe, is not Codex in WSL', () => {
    expect(probeWsl({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: '' }, osRelease: '', exec: recordingExec('').exec }).codexInWsl).toBe(false)
    expect(probeWsl({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: '' }, osRelease: '', exec: recordingExec('/usr/bin/codex', 1).exec }).codexInWsl).toBe(false)
  })

  it('WSL: Codex on the Windows drive mount is the Windows side, never run', () => {
    const mnt = join(home, 'mnt', 'c')
    const winBin = join(mnt, 'Users', 'alice', 'AppData', 'Roaming', 'npm')
    mkdirSync(winBin, { recursive: true })
    writeFileSync(join(winBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    const mounts = `C:\\134 ${mnt} 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000 0 0\nnone /run tmpfs rw 0 0\n`
    const { exec, calls } = recordingExec('')
    const p = probeWsl({ platform: 'linux', env: { PATH: `/usr/bin:${winBin}` }, osRelease: '5.15.167.4-microsoft-standard-WSL2', exec, readMounts: () => mounts })
    expect(p).toEqual({ codexOnPath: false, codexInWsl: false, isWsl: true, codexOnWindows: true })
    expect(calls).toHaveLength(0)
  })

  it('WSL is read from the kernel release only: an env variable cannot fake it', () => {
    const p = probeWsl({ platform: 'linux', env: { PATH: '', WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/x' }, osRelease: '6.8.0-45-generic', exec: recordingExec('').exec, readMounts: () => '' })
    expect(p.isWsl).toBe(false)
  })

  it('Linux: a Codex on PATH (not on a Windows mount) is here', () => {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    const p = probeWsl({ platform: 'linux', env: { PATH: bin }, osRelease: '6.8.0-45-generic', exec: recordingExec('').exec, readMounts: () => '' })
    expect(p.codexOnPath).toBe(true)
  })
})

// ─── wireTools and runPlurInit ────────────────────────────────────────────────

describe('wireTools', () => {
  it('lists only tools with a plur entry or on the other side, with a launch only when it is direct', async () => {
    put('.claude.json', JSON.stringify({ mcpServers: { plur: { command: '/h/.plur/bin/plur-mcp', args: [] } } }))
    put('.config/opencode/opencode.json', JSON.stringify({ mcp: { plur: { type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.22.0'] } } }))
    const results = await wireTools({ mcpEnv: THREE, ...loc, platform: 'win32', parentEnv: { PATH: '/bin' },
      probes: { codexOnPath: false, codexInWsl: true, isWsl: false, codexOnWindows: false } })
    expect(results.map(r => r.tool)).toEqual(['claude-code', 'codex', 'opencode'])
    const [claude, codex, opencode] = results
    expect(claude).toMatchObject({ status: 'wired', configPath: join(home, '.claude.json') })
    expect(launchOf(claude)?.env.NODE_EXTRA_CA_CERTS).toBe(CA)
    expect(codex).toMatchObject({ status: 'other-side', side: 'wsl', detail: OTHER_SIDE_TEXT.wsl })
    expect(opencode.status).toBe('wired')
    expect(launchOf(opencode)).toBeUndefined()
    expect(opencode.detail).toMatch(/through npx/)
  })

  it('inside WSL with Codex on Windows the side is windows, and the Codex config here is not touched', async () => {
    const text = '[mcp_servers.plur]\ncommand = "plur-mcp"\n'
    const path = put('.codex/config.toml', text)
    const [codex] = await wireTools({ mcpEnv: THREE, ...loc, platform: 'linux', parentEnv: {},
      probes: { codexOnPath: false, codexInWsl: false, isWsl: true, codexOnWindows: true } })
    expect(codex).toMatchObject({ tool: 'codex', status: 'other-side', side: 'windows', detail: OTHER_SIDE_TEXT.windows })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('a refused config is reported, not hidden', async () => {
    put('.cursor/mcp.json', '{ nope')
    put('.claude.json', JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }))
    const results = await wireTools({ mcpEnv: THREE, ...loc, platform: 'linux', parentEnv: {}, probes: NO_PROBES })
    expect(results.find(r => r.tool === 'cursor')).toMatchObject({ status: 'refused' })
  })
})

describe('runPlurInit', () => {
  it('runs `<node> <cliEntry> init --no-prompt` and writes its output to an owner-only log', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: ExecFn = (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: 'registered in ~/.claude.json\n' } }
    const log = join(home, '.plur', 'logs', 'init.log')
    expect(runPlurInit(exec, '/opt/plur/cli/dist/index.js', log)).toEqual({ ok: true })
    expect(calls).toEqual([{ cmd: process.execPath, args: ['/opt/plur/cli/dist/index.js', 'init', '--no-prompt'] }])
    expect(readFileSync(log, 'utf8')).toBe('registered in ~/.claude.json\n')
    if (process.platform !== 'win32') expect(statSync(log).mode & 0o777).toBe(0o600)
  })

  it('an existing loose log becomes owner-only; a symlinked log path is replaced, not followed', () => {
    if (process.platform === 'win32') return
    const exec: ExecFn = () => ({ status: 0, stdout: 'ok\n' })
    const log = join(home, 'logs', 'init.log')
    mkdirSync(join(home, 'logs'))
    writeFileSync(log, 'old', { mode: 0o644 })
    chmodSync(log, 0o644)
    runPlurInit(exec, '/x.js', log)
    expect(statSync(log).mode & 0o777).toBe(0o600)
    const elsewhere = join(home, 'elsewhere.txt')
    writeFileSync(elsewhere, 'keep')
    rmSync(log)
    symlinkSync(elsewhere, log)
    runPlurInit(exec, '/x.js', log)
    expect(readFileSync(elsewhere, 'utf8')).toBe('keep')
    expect(readFileSync(log, 'utf8')).toBe('ok\n')
  })

  it('stderr goes into the log too, so a failed init can be diagnosed', () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const exec: ExecFn = (_c, _a, opts) => { seen.push(opts as Record<string, unknown>); return { status: 1, stdout: 'partial\n', stderr: 'Error: Cannot find module /x.js\n' } }
    const log = join(home, 'init.log')
    expect(runPlurInit(exec, '/x.js', log)).toEqual({ ok: false })
    expect(seen[0]?.stderr).toBe(true)
    expect(readFileSync(log, 'utf8')).toContain('partial')
    expect(readFileSync(log, 'utf8')).toContain('Cannot find module')
  })

  it('a non-zero exit is not ok', () => {
    const exec: ExecFn = () => ({ status: 1, stdout: 'Not finished' })
    expect(runPlurInit(exec, '/x.js', join(home, 'init.log'))).toEqual({ ok: false })
  })
})
