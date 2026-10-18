/**
 * Codex round 3, findings 3 and 4 — enterprise legacy cleanup.
 *
 * Finding 3: cleanup derived its replacement from one read of an editor
 * config, the backup re-read the file, and the replacement was then written
 * without checking that the file had not changed in between. A setting the
 * editor (or the user) added in that window vanished from the live config
 * while cleanup reported success. Backup, transformation and replacement are
 * now bound to ONE snapshot; a change since the snapshot is retried from the
 * current contents a bounded number of times, then refused.
 *
 * Finding 4: an OpenCode config with duplicate keys parses last-wins, while
 * the offset editor edits the first occurrence, so the active entry survived
 * and cleanup said "removed". Such configs are now refused, and every edit is
 * verified (re-parsed the way the editor reads it) before it is written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { cleanupLegacy, type ToolId } from '../src/enterprise/cleanup.js'

// All fixtures use obviously fake token values.

let home: string
let backupDir: string
let plurDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-codex3-cleanup-'))
  backupDir = join(home, 'backups')
  plurDir = join(home, '.plur')
  mkdirSync(plurDir, { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: '',
    CODEX_HOME: join(home, '.codex'),
  }
}

interface Editor {
  tool: ToolId
  path: () => string
  initial: string
  /** The same file after a concurrent writer added an unrelated setting. */
  withConcurrentSetting: string
  /** The unrelated setting, as it must appear in the cleaned file. */
  survivor: (text: string) => boolean
}

const editors: Editor[] = [
  {
    tool: 'claude-code',
    path: () => join(home, '.claude.json'),
    initial: JSON.stringify({ mcpServers: { 'plur-enterprise': { command: 'npx', env: { PLUR_ENTERPRISE_TOKEN: 'plur_sk_test_fake' } }, plur: { command: 'plur-mcp' } } }, null, 2),
    withConcurrentSetting: JSON.stringify({ mcpServers: { 'plur-enterprise': { command: 'npx', env: { PLUR_ENTERPRISE_TOKEN: 'plur_sk_test_fake' } }, plur: { command: 'plur-mcp' }, added: { command: 'added-cmd' } } }, null, 2),
    survivor: t => JSON.parse(t).mcpServers.added?.command === 'added-cmd',
  },
  {
    tool: 'cursor',
    path: () => join(home, '.cursor', 'mcp.json'),
    initial: JSON.stringify({ mcpServers: { 'plur-enterprise': { url: 'https://plur.example.com/mcp' }, other: { command: 'o' } } }),
    withConcurrentSetting: JSON.stringify({ mcpServers: { 'plur-enterprise': { url: 'https://plur.example.com/mcp' }, other: { command: 'o' }, added: { command: 'added-cmd' } } }),
    survivor: t => JSON.parse(t).mcpServers.added?.command === 'added-cmd',
  },
  {
    tool: 'codex',
    path: () => join(home, '.codex', 'config.toml'),
    initial: '[mcp_servers.plur-enterprise]\ncommand = "npx"\nargs = []\n\n[mcp_servers.other]\ncommand = "o"\n',
    withConcurrentSetting: '[mcp_servers.plur-enterprise]\ncommand = "npx"\nargs = []\n\n[mcp_servers.other]\ncommand = "o"\n\n[mcp_servers.added]\ncommand = "added-cmd"\n',
    survivor: t => t.includes('[mcp_servers.added]\ncommand = "added-cmd"'),
  },
  {
    tool: 'opencode',
    path: () => join(home, '.config', 'opencode', 'opencode.json'),
    initial: '{\n  // keep\n  "mcp": {\n    "plur-enterprise": { "url": "https://plur.example.com/mcp" },\n    "plur": { "type": "local" }\n  }\n}\n',
    withConcurrentSetting: '{\n  // keep\n  "mcp": {\n    "plur-enterprise": { "url": "https://plur.example.com/mcp" },\n    "plur": { "type": "local" },\n    "added": { "type": "local", "command": ["added-cmd"] }\n  }\n}\n',
    survivor: t => t.includes('"added": { "type": "local", "command": ["added-cmd"] }'),
  },
]

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('finding 3: backup and replacement bound to one snapshot', () => {
  for (const e of editors) {
    it(`${e.tool}: a setting added after the read survives, the entry is still removed`, () => {
      const p = e.path()
      write(p, e.initial)
      const results = cleanupLegacy({
        tools: [e.tool], backupDir, plurDir, home, env: env(),
        afterBackup: (target, attempt) => { if (target === p && attempt === 0) writeFileSync(p, e.withConcurrentSetting) },
      })
      const r = results.find(x => x.target === p)!
      expect(r.status).toBe('removed')
      const now = readFileSync(p, 'utf8')
      expect(e.survivor(now)).toBe(true)
      expect(now).not.toContain('plur-enterprise')
      // The reported backup holds exactly the bytes that were replaced.
      expect(readFileSync(r.backup!, 'utf8')).toBe(e.withConcurrentSetting)
    })

    it(`${e.tool}: a file that keeps changing is refused and left as the other writer made it`, () => {
      const p = e.path()
      write(p, e.initial)
      let n = 0
      const results = cleanupLegacy({
        tools: [e.tool], backupDir, plurDir, home, env: env(),
        afterBackup: target => { if (target === p) writeFileSync(p, n++ % 2 ? e.initial : e.withConcurrentSetting) },
      })
      const r = results.find(x => x.target === p)!
      expect(r.status).toBe('refused')
      expect(r.detail).toMatch(/changed during cleanup/)
      const last = (n - 1) % 2 ? e.initial : e.withConcurrentSetting
      expect(readFileSync(p, 'utf8')).toBe(last)
      expect(readdirSync(join(p, '..')).filter(f => f.endsWith('.tmp'))).toEqual([])
    })
  }

  it('header file: content changed after the read is backed up as it was when removed', () => {
    const header = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(header, 'Authorization: Bearer plur_sk_test_fake_1')
    const results = cleanupLegacy({
      tools: [], backupDir, plurDir, home, env: env(),
      afterBackup: (target, attempt) => { if (target === header && attempt === 0) writeFileSync(header, 'Authorization: Bearer plur_sk_test_fake_2') },
    })
    const r = results.find(x => x.target === header)!
    expect(r.status).toBe('removed')
    expect(existsSync(header)).toBe(false)
    expect(readFileSync(r.backup!, 'utf8')).toBe('Authorization: Bearer plur_sk_test_fake_2')
  })
})

describe('finding 4: OpenCode duplicate keys and post-edit verification', () => {
  const ocPath = () => join(home, '.config', 'opencode', 'opencode.json')

  it('two mcp objects both defining the entry: refused, file unchanged, no backup', () => {
    const text = '{\n  "mcp": { "plur-enterprise": { "url": "https://a.example.com" } },\n  "mcp": { "plur-enterprise": { "url": "https://b.example.com" }, "plur": {} }\n}\n'
    write(ocPath(), text)
    const r = cleanupLegacy({ tools: ['opencode'], backupDir, plurDir, home, env: env() }).find(x => x.target === ocPath())!
    expect(r.status).toBe('refused')
    expect(r.detail).toMatch(/duplicate|ambiguous/i)
    expect(readFileSync(ocPath(), 'utf8')).toBe(text)
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([])
  })

  it('duplicate entry key inside mcp: refused, file unchanged', () => {
    const text = '{"mcp":{"plur-enterprise":{"url":"https://a.example.com"},"plur-enterprise":{"url":"https://b.example.com"}}}'
    write(ocPath(), text)
    const r = cleanupLegacy({ tools: ['opencode'], backupDir, plurDir, home, env: env() }).find(x => x.target === ocPath())!
    expect(r.status).toBe('refused')
    expect(readFileSync(ocPath(), 'utf8')).toBe(text)
  })

  it('a byte-order mark is still accepted (not mistaken for ambiguity)', () => {
    write(ocPath(), '﻿{"mcp":{"plur-enterprise":{"url":"https://a.example.com"},"plur":{}}}')
    const r = cleanupLegacy({ tools: ['opencode'], backupDir, plurDir, home, env: env() }).find(x => x.target === ocPath())!
    expect(r.status).toBe('removed')
    const now = readFileSync(ocPath(), 'utf8')
    expect(now).not.toContain('plur-enterprise')
    expect(now).toContain('"plur"')
  })
})
