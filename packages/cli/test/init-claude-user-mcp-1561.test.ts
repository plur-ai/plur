/**
 * #1561 (0.21.1 pre-release integration check, F2): `plur init` gave Claude
 * Code its hooks but no PLUR MCP tools. It wrote `mcpServers.plur` into
 * `~/.claude/settings.json`, and Claude Code does not read MCP servers from
 * that file. User-scoped servers live in `~/.claude.json`, which is what
 * `claude mcp add --scope user` writes. `claude mcp list` showed nothing, and
 * `plur doctor` still said "registered" because it read the settings entry.
 *
 *   - init registers the server in `~/.claude.json`, keeping the rest of that
 *     file, and needs no `claude` CLI to do it;
 *   - an old entry in settings.json is moved, with its env and extra keys, and
 *     settings.json is backed up first; its other servers and keys stay;
 *   - an entry already in `~/.claude.json` wins: the old one is only removed;
 *   - a second run changes no byte; an unparseable `~/.claude.json` is
 *     refused and neither file is touched;
 *   - doctor counts only places Claude Code reads (user or local scope in
 *     `~/.claude.json`, a project `.mcp.json`) and fails, naming the fix, when
 *     the hooks are installed but the server is not there.
 *
 * Real spawned CLI with HOME, USERPROFILE, TMPDIR and PLUR_PATH inside a temp
 * directory, so the real ~/.claude, ~/.claude.json and ~/.plur are never
 * touched. PATH is the parent's; nothing here runs the `claude` CLI except the
 * opt-in check at the end (PLUR_TEST_REAL_CLAUDE=1), which also runs it under
 * the temp HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, statSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))

type Json = Record<string, any>

let home: string
let work: string
let env: NodeJS.ProcessEnv

const userConfig = () => join(home, '.claude.json')
const settingsFile = () => join(home, '.claude', 'settings.json')
const read = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'))
const backups = (dir: string, base: string) => readdirSync(dir).filter(n => n.startsWith(`${base}.plur-backup-`))

function initRaw(...args: string[]): { status: number; out: string } {
  const r = runCli('node', [CLI, 'init', '--no-desktop', '--no-prompt', '--no-codex', '--no-cursor', '--no-antigravity', '--no-opencode', ...args], {
    encoding: 'utf-8', env, cwd: work, input: '',
  })
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function init(...args: string[]): string {
  const r = initRaw(...args)
  expect(r.status, r.out).toBe(0)
  return r.out
}

function doctor(): { report: Json; status: number } {
  const json = runCli('node', [CLI, 'doctor', '--no-handshake', '--json'], {
    encoding: 'utf-8', env: { ...env, PLUR_DISABLE_EMBEDDINGS: '1' }, cwd: work,
  })
  return { report: JSON.parse(json.stdout ?? '{}'), status: json.status ?? 1 }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-init-1561-')))
  mkdirSync(join(home, 'tmp'))
  work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  env = { ...isolatedHomeEnv(home), TMPDIR: join(home, 'tmp'), PLUR_DISABLE_EMBEDDINGS: '1' }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('plur init registers the PLUR MCP server where Claude Code reads it (#1561)', () => {
  it('fresh machine: ~/.claude.json gets mcpServers.plur; settings.json keeps the hooks and no MCP entry', () => {
    const out = init()
    expect(existsSync(userConfig())).toBe(true)
    const plur = read(userConfig()).mcpServers?.plur
    expect(plur).toBeDefined()
    expect(typeof plur.command).toBe('string')
    const settings = read(settingsFile())
    expect(settings.mcpServers?.plur).toBeUndefined()
    expect(Object.keys(settings.hooks ?? {})).toContain('UserPromptSubmit')
    expect(out).toContain(userConfig())
    // ~/.claude.json holds Claude Code's own state, so a new one is private.
    if (process.platform !== 'win32') expect(statSync(userConfig()).mode & 0o777).toBe(0o600)
  })

  it('keeps everything else in an existing ~/.claude.json, and its file mode', () => {
    const before = {
      firstStartTime: '2026-01-01T00:00:00.000Z',
      projects: { '/some/where': { allowedTools: [], mcpServers: {} } },
      mcpServers: { other: { type: 'stdio', command: '/bin/echo', args: ['x'], env: {} } },
    }
    writeFileSync(userConfig(), JSON.stringify(before, null, 2), { mode: 0o600 })
    init()
    const after = read(userConfig())
    expect(after.firstStartTime).toBe(before.firstStartTime)
    expect(after.projects).toEqual(before.projects)
    expect(after.mcpServers.other).toEqual(before.mcpServers.other)
    expect(after.mcpServers.plur).toBeDefined()
    if (process.platform !== 'win32') expect(statSync(userConfig()).mode & 0o777).toBe(0o600)
    // The changed file was backed up first.
    expect(backups(home, '.claude.json').length).toBe(1)
  })

  it('moves an old settings.json entry to ~/.claude.json with its env and extra keys, after a backup; other servers and keys stay', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const legacy = { command: join(home, '.plur', 'bin', 'plur-mcp'), args: [], env: { PLUR_PATH: '/custom/store' }, timeout: 30 }
    writeFileSync(settingsFile(), JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      mcpServers: { plur: legacy, github: { command: 'npx', args: ['-y', 'gh-mcp'] } },
    }, null, 2))
    const out = init()
    const moved = read(userConfig()).mcpServers.plur
    expect(moved.env).toEqual({ PLUR_PATH: '/custom/store' })
    expect(moved.timeout).toBe(30)
    const settings = read(settingsFile())
    expect(settings.mcpServers?.plur).toBeUndefined()
    expect(settings.mcpServers?.github).toEqual({ command: 'npx', args: ['-y', 'gh-mcp'] })
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] })
    // A backup of settings.json from before the move holds the old entry.
    const saved = backups(join(home, '.claude'), 'settings.json')
    expect(saved.length).toBeGreaterThanOrEqual(1)
    expect(saved.some(b => read(join(home, '.claude', b)).mcpServers?.plur !== undefined)).toBe(true)
    expect(out).toMatch(/moved/i)
  })

  it('an old settings.json entry with nothing else in mcpServers leaves no empty mcpServers behind', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    init()
    expect(read(settingsFile()).mcpServers).toBeUndefined()
    expect(read(userConfig()).mcpServers.plur.command).toBe('/opt/plur-mcp')
  })

  it('when ~/.claude.json already has plur, the old settings entry is removed, not copied over it', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const current = { command: '/usr/local/bin/my-plur-mcp', args: ['--x'] }
    writeFileSync(userConfig(), JSON.stringify({ mcpServers: { plur: current } }, null, 2))
    writeFileSync(settingsFile(), JSON.stringify({ mcpServers: { plur: { command: '/old/plur-mcp', args: [] } } }))
    init()
    const servers = read(userConfig()).mcpServers
    expect(servers.plur).toEqual(current)
    expect(Object.keys(servers).filter(k => k === 'plur')).toHaveLength(1)
    expect(read(settingsFile()).mcpServers?.plur).toBeUndefined()
  })

  it('a second run changes no byte of either file and makes no new backup', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    init()
    const user1 = readFileSync(userConfig(), 'utf8')
    const settings1 = readFileSync(settingsFile(), 'utf8')
    const b1 = [...backups(home, '.claude.json'), ...backups(join(home, '.claude'), 'settings.json')]
    const out = init()
    expect(readFileSync(userConfig(), 'utf8')).toBe(user1)
    expect(readFileSync(settingsFile(), 'utf8')).toBe(settings1)
    expect([...backups(home, '.claude.json'), ...backups(join(home, '.claude'), 'settings.json')]).toEqual(b1)
    expect(out).toMatch(/MCP server \(plur\): already registered/)
  })

  it('an unparseable ~/.claude.json is refused: neither it nor the old settings entry is touched', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const broken = '{ "mcpServers": { "a": {}, }'
    writeFileSync(userConfig(), broken)
    writeFileSync(settingsFile(), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    const { status, out } = initRaw()
    // #1564 review L4: the registration did not happen, so init fails.
    expect(status).not.toBe(0)
    expect(readFileSync(userConfig(), 'utf8')).toBe(broken)
    expect(read(settingsFile()).mcpServers?.plur).toEqual({ command: '/opt/plur-mcp', args: [] })
    expect(out).toMatch(/MCP server \(plur\): not registered/)
    expect(out).toContain(userConfig())
  })

  it('an mcpServers that is not an object is refused: init fails, no backup, never "registered" (#1564 review L5)', () => {
    const text = JSON.stringify({ mcpServers: [] })
    writeFileSync(userConfig(), text)
    const { status, out } = initRaw()
    expect(status).not.toBe(0)
    expect(readFileSync(userConfig(), 'utf8')).toBe(text)
    expect(backups(home, '.claude.json')).toEqual([])
    expect(out).toMatch(/mcpServers/)
    expect(out).not.toMatch(/MCP server \(plur\): registered/)
  })

  it.skipIf(process.platform === 'win32')('a dangling ~/.claude.json symlink is named, and init fails (#1564 review L4)', () => {
    symlinkSync(join(home, 'gone.json'), userConfig())
    const { status, out } = initRaw()
    expect(status).not.toBe(0)
    expect(out).toMatch(/symlink/)
    expect(out).not.toMatch(/run again/)
  })

  it('--project also registers the server in ~/.claude.json', () => {
    mkdirSync(join(work, '.git'), { recursive: true })
    init('--project')
    expect(read(userConfig()).mcpServers?.plur).toBeDefined()
  })
})

describe('plur doctor checks where Claude Code reads MCP servers (#1561)', () => {
  const hooks = {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${join('~', '.plur', 'bin', 'plur-hook')} hook-inject` }] }],
  }

  it('hooks installed, server only in settings.json: not registered, fails, and names the fix', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ hooks, mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    const { report, status } = doctor()
    expect(report.mcpRegistered).toBe(false)
    expect(report.claudeCodeMcp).toMatchObject({ registered: false, legacySettingsEntry: true })
    expect(report.overall).toBe('fail')
    expect(status).toBe(1)
    // The fix is named in the report itself (piped doctor output is JSON;
    // printText renders this same string).
    expect(report.claudeCodeMcp.fix).toContain('plur init')
    expect(report.claudeCodeMcp.fix).toContain('.claude.json')
  })

  it('hooks installed, no server anywhere: fails', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ hooks }))
    const { report } = doctor()
    expect(report.mcpRegistered).toBe(false)
    expect(report.claudeCodeMcp).toMatchObject({ registered: false, legacySettingsEntry: false })
    expect(report.overall).toBe('fail')
  })

  it('user scope in ~/.claude.json counts', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ hooks }))
    writeFileSync(userConfig(), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    const { report } = doctor()
    expect(report.mcpRegistered).toBe(true)
    expect(report.claudeCodeMcp).toMatchObject({ registered: true, scope: 'user' })
  })

  it('local scope for this folder in ~/.claude.json counts (what a bare `claude mcp add` writes)', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ hooks }))
    writeFileSync(userConfig(), JSON.stringify({ projects: { [work]: { mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } } } }))
    const { report } = doctor()
    expect(report.mcpRegistered).toBe(true)
    expect(report.claudeCodeMcp).toMatchObject({ registered: true, scope: 'local' })
  })

  it('a project .mcp.json counts', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ hooks }))
    writeFileSync(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    const { report } = doctor()
    expect(report.mcpRegistered).toBe(true)
    expect(report.claudeCodeMcp).toMatchObject({ registered: true, scope: 'project' })
  })

  // #1564 review M1/L3: Claude Code keys local scope by the git root, finds
  // .mcp.json in parent folders, and prefers local over project over user.
  function doctorIn(cwd: string): Json {
    const r = runCli('node', [CLI, 'doctor', '--no-handshake', '--json'], {
      encoding: 'utf-8', env: { ...env, PLUR_DISABLE_EMBEDDINGS: '1' }, cwd,
    })
    return JSON.parse(r.stdout ?? '{}')
  }
  function repoWithSub(): { repo: string; sub: string } {
    const repo = join(work, 'repo')
    const sub = join(repo, 'sub', 'deeper')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify({ hooks }))
    return { repo, sub }
  }
  const entry = { command: '/opt/plur-mcp', args: [] }

  it('local scope keyed by the git root counts from a subfolder of the repo, with no `plur init` advice', () => {
    const { repo, sub } = repoWithSub()
    writeFileSync(userConfig(), JSON.stringify({ projects: { [repo]: { mcpServers: { plur: entry } } } }))
    const report = doctorIn(sub)
    expect(report.claudeCodeMcp).toMatchObject({ registered: true, scope: 'local' })
    expect(report.claudeCodeMcp.fix).toBeUndefined()
    expect(report.mcpRegistered).toBe(true)
  })

  it('a .mcp.json in a parent folder counts from a subfolder', () => {
    const { repo, sub } = repoWithSub()
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: entry } }))
    const report = doctorIn(sub)
    expect(report.claudeCodeMcp).toMatchObject({ registered: true, scope: 'project', path: join(repo, '.mcp.json') })
  })

  it('reports Claude Code\'s precedence: local over project over user', () => {
    const { repo, sub } = repoWithSub()
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: entry } }))
    writeFileSync(userConfig(), JSON.stringify({ mcpServers: { plur: entry } }))
    expect(doctorIn(sub).claudeCodeMcp.scope).toBe('project')
    writeFileSync(userConfig(), JSON.stringify({ mcpServers: { plur: entry }, projects: { [repo]: { mcpServers: { plur: entry } } } }))
    expect(doctorIn(sub).claudeCodeMcp.scope).toBe('local')
  })

  it('after `plur init`, doctor sees the server in ~/.claude.json', () => {
    init()
    const { report } = doctor()
    expect(report.claudeCodeMcp).toMatchObject({ registered: true, scope: 'user' })
    expect(report.mcpRegistered).toBe(true)
  })
})

// Opt-in: the real Claude Code CLI, under the same temp HOME. Not in CI (no
// `claude` there, and it may want network). Run with PLUR_TEST_REAL_CLAUDE=1.
const realClaude = process.env.PLUR_TEST_REAL_CLAUDE === '1'
describe.skipIf(!realClaude)('the real `claude` CLI sees the server init registered (#1561)', () => {
  it('claude mcp get plur reports it in user config', () => {
    init()
    const r = spawnSync('claude', ['mcp', 'get', 'plur'], { encoding: 'utf-8', env, cwd: work, timeout: 60_000 })
    expect(`${r.stdout}${r.stderr}`).toContain('User config')
  }, 90_000)
})
