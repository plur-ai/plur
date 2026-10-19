// Regression tests for the formal-verification findings on the enterprise
// installer (spec/formal/findings/installer.md). Each test was red before its fix.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseInitArgs } from '../src/enterprise/args.js'
import { cleanupLegacy } from '../src/enterprise/cleanup.js'
import { formatSummary, type EnterpriseInitResult } from '../src/enterprise/summary.js'

// ─── I5: a flag given an empty value ─────────────────────────────────────────

describe('init arguments: an empty value is a missing value (installer I5)', () => {
  it('--server "" is an error, not a silent fall-back to PLUR_SERVER', () => {
    expect(parseInitArgs(['init', '--server', ''], { PLUR_SERVER: 'https://other.example.com' })).toEqual({
      error: '--server needs a value',
    })
  })

  it('every value flag refuses an empty value', () => {
    for (const flag of ['--expect-version', '--ca-file', '--ca-sha256', '--proxy', '--mode']) {
      expect(parseInitArgs(['init', '--server', 'https://plur.example.com', flag, ''], {})).toEqual({
        error: `${flag} needs a value`,
      })
    }
  })

  it('a non-empty value still parses', () => {
    expect(parseInitArgs(['init', '--server', 'https://plur.example.com', '--ca-file', '/etc/ca.pem'], {})).toMatchObject({
      server: 'https://plur.example.com',
      caFile: '/etc/ca.pem',
    })
  })
})

// ─── I2: header file, config that cannot be looked at ────────────────────────

const canDenyAccess =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

describe('header file: a config that cannot be looked at keeps it (installer I2)', () => {
  let home: string
  let plurDir: string
  let backupDir: string
  const locked: string[] = []

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-formal-inst-'))
    plurDir = join(home, '.plur')
    backupDir = join(home, 'backups')
    mkdirSync(plurDir, { recursive: true })
  })

  afterEach(() => {
    for (const d of locked.splice(0)) chmodSync(d, 0o700)
    rmSync(home, { recursive: true, force: true })
  })

  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: '',
    CODEX_HOME: join(home, '.codex'),
  })

  it.skipIf(!canDenyAccess)('an untraversable Cursor folder whose config has the legacy entry keeps the header', () => {
    const header = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(header, 'Authorization: Bearer plur_sk_test_fake')
    const cursorDir = join(home, '.cursor')
    mkdirSync(cursorDir)
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'plur-enterprise': { headersFile: header } } }),
    )
    chmodSync(cursorDir, 0o000)
    locked.push(cursorDir)

    const r = cleanupLegacy({ tools: [], backupDir, plurDir, home, env: env() }).find(e => e.target === header)

    expect(r?.status).toBe('refused')
    expect(r?.detail).toMatch(/could not be read/)
    expect(existsSync(header)).toBe(true)
    expect(readFileSync(header, 'utf8')).toBe('Authorization: Bearer plur_sk_test_fake')
  })

  it.skipIf(!canDenyAccess)('an untraversable Codex home keeps the header', () => {
    const header = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(header, 'Authorization: Bearer plur_sk_test_fake')
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir)
    writeFileSync(join(codexDir, 'config.toml'), '[mcp_servers.plur-enterprise]\ncommand = "old"\n')
    chmodSync(codexDir, 0o000)
    locked.push(codexDir)

    const r = cleanupLegacy({ tools: [], backupDir, plurDir, home, env: env() }).find(e => e.target === header)

    expect(r?.status).toBe('refused')
    expect(existsSync(header)).toBe(true)
  })

  it('with every config absent the header is still removed (good case reachable)', () => {
    const header = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(header, 'x')
    const r = cleanupLegacy({ tools: [], backupDir, plurDir, home, env: env() }).find(e => e.target === header)
    expect(r?.status).toBe('removed')
    expect(existsSync(header)).toBe(false)
  })
})

// ─── I6: summary never shows an unbacked "wired — restart" ───────────────────

const base: EnterpriseInitResult = {
  ok: false,
  signIn: { username: 'alice', keyName: 'alice — ws-0142', reused: false },
  hello: null,
  tools: [],
  writeCheck: [{ scope: 'group:acme/team', writable: true, review_held: false }],
  uploadCandidates: 0,
}

describe('summary: "wired — restart" only with the evidence for it (installer I6)', () => {
  it('proven:true but the hello save failed → not plainly wired', () => {
    const r: EnterpriseInitResult = {
      ...base,
      hello: { saved: { ok: false, reason: 'queued on this device, not delivered to the server' }, perTool: [] },
      tools: [{ tool: 'codex', status: 'wired', configPath: '/c', proven: true }],
    }
    const lines = formatSummary(r)
    expect(lines.some(l => l.includes('wired — restart'))).toBe(false)
    expect(lines.some(l => l.includes('Codex') && l.includes('wired, but not proven'))).toBe(true)
  })

  it('proven:true but no hello ran → not plainly wired', () => {
    const r: EnterpriseInitResult = {
      ...base,
      tools: [{ tool: 'cursor', status: 'wired', configPath: '/c', proven: true }],
    }
    expect(formatSummary(r).some(l => l.includes('wired — restart'))).toBe(false)
  })

  it("proven:true but this tool's recall missed → shows the recall reason", () => {
    const reason = "saved, but OpenCode's environment could not recall it"
    const r: EnterpriseInitResult = {
      ...base,
      hello: { saved: { ok: true, id: 'ENG-1' }, perTool: [{ tool: 'opencode', recalled: false, reason }] },
      tools: [{ tool: 'opencode', status: 'wired', configPath: '/c', proven: true }],
    }
    expect(formatSummary(r)).toContain(`• OpenCode  wired, but not proven: ${reason}`)
  })

  it('proven:true but no recall entry for this tool → not plainly wired', () => {
    const r: EnterpriseInitResult = {
      ...base,
      hello: { saved: { ok: true, id: 'ENG-1' }, perTool: [{ tool: 'codex', recalled: true }] },
      tools: [{ tool: 'cursor', status: 'wired', configPath: '/c', proven: true }],
    }
    expect(formatSummary(r).some(l => l.includes('wired — restart'))).toBe(false)
  })

  it('save ok, recall hit, version ok → plainly wired (good case reachable)', () => {
    const r: EnterpriseInitResult = {
      ...base,
      ok: true,
      hello: { saved: { ok: true, id: 'ENG-1' }, perTool: [{ tool: 'cursor', recalled: true }] },
      tools: [{ tool: 'cursor', status: 'wired', configPath: '/c', proven: true, version: { ok: true } }],
    }
    expect(formatSummary(r)).toContain('• Cursor  wired — restart Cursor')
  })
})
