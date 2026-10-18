/**
 * #1561 sibling: `plur-mcp init` wrote the server into `<cwd>/.mcp.json`, or
 * into `~/.claude/mcp.json` when that file existed. Claude Code never reads
 * `~/.claude/mcp.json`. Like `plur init`, it now registers at user scope in
 * `~/.claude.json` (what `claude mcp add --scope user` writes): an old entry
 * in `~/.claude/mcp.json` is moved (env and extra keys kept, both files backed
 * up first), an existing `~/.claude.json` entry wins, a second run writes
 * nothing, an unparseable `~/.claude.json` is refused.
 *
 * Real spawned `plur-mcp init` with HOME, USERPROFILE, TMPDIR and PLUR_PATH in
 * a temp directory; the real ~/.claude, ~/.claude.json and ~/.plur are never
 * touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const MCP = join(__dirname, '..', 'dist', 'index.js')

type Json = Record<string, any>
let home: string
let work: string

const userConfig = () => join(home, '.claude.json')
const legacyFile = () => join(home, '.claude', 'mcp.json')
const read = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'))
const backups = (dir: string, base: string) => existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith(`${base}.plur-backup-`)) : []

function init(expectOk = true): string {
  const r = spawnSync('node', [MCP, 'init'], {
    encoding: 'utf-8', cwd: work, timeout: 120_000, input: '',
    env: {
      ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp'),
      XDG_CONFIG_HOME: join(home, '.config'), PLUR_PATH: join(home, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1', PLUR_TELEMETRY: '', PLUR_BACKEND: '',
    },
  })
  if (expectOk) expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  else expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0)
  return r.stdout ?? ''
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-init-1561-')))
  mkdirSync(join(home, 'tmp'))
  work = join(home, 'work')
  mkdirSync(work, { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('plur-mcp init registers in ~/.claude.json (#1561)', { timeout: 300_000 }, () => {
  it('fresh machine: ~/.claude.json gets plur (private file); no .mcp.json and no ~/.claude/mcp.json are written', () => {
    const out = init()
    expect(read(userConfig()).mcpServers?.plur).toBeDefined()
    if (process.platform !== 'win32') expect(statSync(userConfig()).mode & 0o777).toBe(0o600)
    expect(existsSync(join(work, '.mcp.json'))).toBe(false)
    expect(existsSync(legacyFile())).toBe(false)
    expect(out).toContain(userConfig())
  })

  it('moves an old ~/.claude/mcp.json entry with its env and extra keys, after backups; other servers stay', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(userConfig(), JSON.stringify({ firstStartTime: 'x', mcpServers: { other: { command: '/bin/echo', args: [] } } }), { mode: 0o600 })
    writeFileSync(legacyFile(), JSON.stringify({ mcpServers: {
      plur: { command: '/opt/plur-mcp', args: [], env: { PLUR_PATH: '/custom' }, timeout: 30 },
      github: { command: 'npx', args: ['gh'] },
    } }))
    const out = init()
    const user = read(userConfig())
    expect(user.firstStartTime).toBe('x')
    expect(user.mcpServers.other).toEqual({ command: '/bin/echo', args: [] })
    expect(user.mcpServers.plur).toEqual({ command: '/opt/plur-mcp', args: [], env: { PLUR_PATH: '/custom' }, timeout: 30 })
    const legacy = read(legacyFile())
    expect(legacy.mcpServers?.plur).toBeUndefined()
    expect(legacy.mcpServers?.github).toEqual({ command: 'npx', args: ['gh'] })
    expect(backups(home, '.claude.json')).toHaveLength(1)
    expect(backups(join(home, '.claude'), 'mcp.json')).toHaveLength(1)
    expect(out).toMatch(/moved/i)
  })

  it('an existing ~/.claude.json entry wins; the old one is only removed', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const mine = { command: '/usr/local/bin/my-plur', args: ['--x'] }
    writeFileSync(userConfig(), JSON.stringify({ mcpServers: { plur: mine } }))
    writeFileSync(legacyFile(), JSON.stringify({ mcpServers: { plur: { command: '/old', args: [] } } }))
    init()
    expect(read(userConfig()).mcpServers.plur).toEqual(mine)
    expect(read(legacyFile()).mcpServers).toBeUndefined()
  })

  it('a second run changes no byte and makes no new backup', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(legacyFile(), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    init()
    const u1 = readFileSync(userConfig(), 'utf8')
    const l1 = readFileSync(legacyFile(), 'utf8')
    const b1 = [...backups(home, '.claude.json'), ...backups(join(home, '.claude'), 'mcp.json')]
    const out = init()
    expect(readFileSync(userConfig(), 'utf8')).toBe(u1)
    expect(readFileSync(legacyFile(), 'utf8')).toBe(l1)
    expect([...backups(home, '.claude.json'), ...backups(join(home, '.claude'), 'mcp.json')]).toEqual(b1)
    expect(out).toMatch(/MCP:\s+already registered/)
  })

  it('an unparseable ~/.claude.json is refused; neither file is touched', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const broken = '{ "mcpServers": { "a": {}, }'
    writeFileSync(userConfig(), broken)
    writeFileSync(legacyFile(), JSON.stringify({ mcpServers: { plur: { command: '/opt/plur-mcp', args: [] } } }))
    // #1564 review L4: the registration did not happen, so init fails.
    const out = init(false)
    expect(readFileSync(userConfig(), 'utf8')).toBe(broken)
    expect(read(legacyFile()).mcpServers.plur).toEqual({ command: '/opt/plur-mcp', args: [] })
    expect(out).toMatch(/MCP:\s+not registered/)
  })
})
