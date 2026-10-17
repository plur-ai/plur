import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, symlinkSync, lstatSync, readdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { cleanupLegacy } from '../src/enterprise/cleanup.js'

// All test fixtures use obviously-fake token values.

let home: string
let backupDir: string
let plurDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-cleanup-'))
  backupDir = join(home, 'backups')
  plurDir = join(home, '.plur')
  mkdirSync(plurDir, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function makeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENCODE_CONFIG_DIR: '',
    CODEX_HOME: join(home, '.codex'),
  }
}

// ─── Claude Code: ~/.claude.json ────────────────────────────────────────────

describe('claude-code cleanup', () => {
  it('removes plur-enterprise at top level and in projects, preserves other entries, backs up original', () => {
    const claudeJson = join(home, '.claude.json')
    const original = {
      mcpServers: {
        'plur-enterprise': { command: 'npx', args: ['-y', '@plur-enterprise/mcp@0.1.0'], env: { PLUR_ENTERPRISE_TOKEN: 'plur_sk_test_fake' } },
        other: { command: 'other-cmd', args: [] },
        plur: { command: 'plur-mcp', args: [] },
      },
      projects: {
        '/workspace': {
          mcpServers: {
            'plur-enterprise': { command: 'old', args: [] },
          },
        },
      },
    }
    writeFileSync(claudeJson, JSON.stringify(original, null, 2) + '\n')

    const results = cleanupLegacy({ tools: ['claude-code'], backupDir, plurDir, home })

    const r = results.find(e => e.target === claudeJson)
    expect(r?.status).toBe('removed')
    expect(r?.backup).toBeDefined()

    // backup equals original
    expect(JSON.parse(readFileSync(r!.backup!, 'utf8'))).toEqual(original)

    // plur-enterprise gone at both levels
    const cleaned = JSON.parse(readFileSync(claudeJson, 'utf8'))
    expect(cleaned.mcpServers).not.toHaveProperty('plur-enterprise')
    expect(cleaned.projects['/workspace'].mcpServers).not.toHaveProperty('plur-enterprise')

    // other and plur deep-equal
    expect(cleaned.mcpServers.other).toEqual(original.mcpServers.other)
    expect(cleaned.mcpServers.plur).toEqual(original.mcpServers.plur)
  })

  it('returns absent when plur-enterprise is not in the file', () => {
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { plur: {} } }, null, 2))
    const results = cleanupLegacy({ tools: ['claude-code'], backupDir, plurDir, home })
    const r = results.find(e => e.target === claudeJson)
    expect(r?.status).toBe('absent')
    expect(r?.backup).toBeUndefined()
  })

  it('returns absent when file does not exist', () => {
    const results = cleanupLegacy({ tools: ['claude-code'], backupDir, plurDir, home })
    const r = results.find(e => e.target === join(home, '.claude.json'))
    expect(r?.status).toBe('absent')
  })
})

// ─── Codex: ~/.codex/config.toml ────────────────────────────────────────────

describe('codex cleanup', () => {
  it('removes plur-enterprise sections; other section is byte-identical', () => {
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const codexToml = join(codexDir, 'config.toml')

    const tomlContent = [
      '[mcp_servers.plur-enterprise]',
      'command = "npx"',
      'args = ["-y", "@plur-enterprise/mcp@0.1.0"]',
      '',
      '[mcp_servers.plur-enterprise.env]',
      'PLUR_ENTERPRISE_TOKEN = "plur_sk_test_fake"',
      '',
      '[mcp_servers.other]',
      'command = "other-command"',
      'args = []',
      '',
    ].join('\n')

    writeFileSync(codexToml, tomlContent)

    const env = makeEnv()
    const results = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env })

    const r = results.find(e => e.target === codexToml)
    expect(r?.status).toBe('removed')

    const cleaned = readFileSync(codexToml, 'utf8')
    expect(cleaned).not.toContain('[mcp_servers.plur-enterprise]')
    expect(cleaned).not.toContain('[mcp_servers.plur-enterprise.env]')

    // other section byte-identical: it starts at a known position in the result
    expect(cleaned).toContain('[mcp_servers.other]\ncommand = "other-command"\nargs = []\n')
  })

  it('returns absent when plur-enterprise is not present in TOML', () => {
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const codexToml = join(codexDir, 'config.toml')
    writeFileSync(codexToml, '[mcp_servers.other]\ncommand = "x"\n')

    const env = makeEnv()
    const results = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env })
    const r = results.find(e => e.target === codexToml)
    expect(r?.status).toBe('absent')
  })

  it('returns absent when codex config.toml does not exist', () => {
    const env = makeEnv()
    const results = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env })
    const codexToml = join(home, '.codex', 'config.toml')
    const r = results.find(e => e.target === codexToml)
    expect(r?.status).toBe('absent')
  })
})

// ─── OpenCode: opencode.json(c) ──────────────────────────────────────────────

describe('opencode cleanup', () => {
  it('removes mcp.plur-enterprise from JSONC while preserving comments', () => {
    const opencodeDir = join(home, '.config', 'opencode')
    mkdirSync(opencodeDir, { recursive: true })
    const opencodePath = join(opencodeDir, 'opencode.jsonc')

    const jsoncContent = [
      '{',
      '  // keep me',
      '  "mcp": {',
      '    "plur": { "type": "local", "command": ["plur-mcp"] },',
      '    "plur-enterprise": { "url": "https://plur.example.com/mcp", "env": { "PLUR_API_KEY": "plur_sk_test_fake" } }',
      '  }',
      '}',
    ].join('\n')

    writeFileSync(opencodePath, jsoncContent)

    const env = makeEnv()
    const results = cleanupLegacy({ tools: ['opencode'], backupDir, plurDir, home, env })

    const r = results.find(e => e.target === opencodePath)
    expect(r?.status).toBe('removed')

    const cleaned = readFileSync(opencodePath, 'utf8')
    expect(cleaned).toContain('// keep me')
    expect(cleaned).not.toContain('plur-enterprise')
    // plur entry preserved
    expect(cleaned).toContain('"plur"')
  })

  it('returns absent when plur-enterprise is not present', () => {
    const opencodeDir = join(home, '.config', 'opencode')
    mkdirSync(opencodeDir, { recursive: true })
    const opencodePath = join(opencodeDir, 'opencode.json')
    writeFileSync(opencodePath, '{"mcp":{"plur":{"type":"local","command":["plur-mcp"]}}}')

    const env = makeEnv()
    const results = cleanupLegacy({ tools: ['opencode'], backupDir, plurDir, home, env })
    const r = results.find(e => e.target === opencodePath)
    expect(r?.status).toBe('absent')
  })
})

// ─── Cursor: ~/.cursor/mcp.json ──────────────────────────────────────────────

describe('cursor cleanup', () => {
  it('removes plur-enterprise from cursor mcp.json', () => {
    const cursorDir = join(home, '.cursor')
    mkdirSync(cursorDir, { recursive: true })
    const cursorMcp = join(cursorDir, 'mcp.json')
    const original = {
      mcpServers: {
        'plur-enterprise': { url: 'https://plur.example.com/mcp' },
        plur: { command: 'plur-mcp', args: [] },
      },
    }
    writeFileSync(cursorMcp, JSON.stringify(original, null, 2))

    const results = cleanupLegacy({ tools: ['cursor'], backupDir, plurDir, home })
    const r = results.find(e => e.target === cursorMcp)
    expect(r?.status).toBe('removed')

    const cleaned = JSON.parse(readFileSync(cursorMcp, 'utf8'))
    expect(cleaned.mcpServers).not.toHaveProperty('plur-enterprise')
    expect(cleaned.mcpServers.plur).toEqual(original.mcpServers.plur)
  })

  it('refused and bytes unchanged for unparsable cursor mcp.json, no backup written', () => {
    const cursorDir = join(home, '.cursor')
    mkdirSync(cursorDir, { recursive: true })
    const cursorMcp = join(cursorDir, 'mcp.json')
    const badJson = '{ nope'
    writeFileSync(cursorMcp, badJson)

    const results = cleanupLegacy({ tools: ['cursor'], backupDir, plurDir, home })
    const r = results.find(e => e.target === cursorMcp)
    expect(r?.status).toBe('refused')
    expect(readFileSync(cursorMcp, 'utf8')).toBe(badJson)
    expect(r?.backup).toBeUndefined()
  })

  it('returns absent when file does not exist', () => {
    const results = cleanupLegacy({ tools: ['cursor'], backupDir, plurDir, home })
    const cursorMcp = join(home, '.cursor', 'mcp.json')
    const r = results.find(e => e.target === cursorMcp)
    expect(r?.status).toBe('absent')
  })
})

// ─── Header file ─────────────────────────────────────────────────────────────

describe('header file cleanup', () => {
  it('removes header file and backs it up with mode 0600 (skipIf win32)', () => {
    const headerPath = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(headerPath, 'Authorization: Bearer plur_sk_test_fake')

    const results = cleanupLegacy({ tools: [], backupDir, plurDir, home })
    const r = results.find(e => e.target === headerPath)
    expect(r?.status).toBe('removed')
    expect(r?.backup).toBeDefined()
    expect(existsSync(headerPath)).toBe(false)

    if (process.platform !== 'win32') {
      const mode = statSync(r!.backup!).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('returns absent when header file does not exist', () => {
    const results = cleanupLegacy({ tools: [], backupDir, plurDir, home })
    const headerPath = join(plurDir, 'mcp-enterprise-header')
    const r = results.find(e => e.target === headerPath)
    expect(r?.status).toBe('absent')
  })
})

// ─── Tools filter ─────────────────────────────────────────────────────────────

describe('tools filter', () => {
  it('only cleans tools in the list; unlisted tool files are untouched', () => {
    // Write a claude.json with plur-enterprise
    const claudeJson = join(home, '.claude.json')
    const original = JSON.stringify({ mcpServers: { 'plur-enterprise': { command: 'x' } } }, null, 2)
    writeFileSync(claudeJson, original)

    // Write a codex config with plur-enterprise
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const codexToml = join(codexDir, 'config.toml')
    writeFileSync(codexToml, '[mcp_servers.plur-enterprise]\ncommand = "npx"\nargs = []\n')

    // Only pass 'codex' in tools
    const env = makeEnv()
    const results = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env })

    // No claude-code result in results
    const claudeResult = results.find(e => e.target === claudeJson)
    expect(claudeResult).toBeUndefined()

    // Claude file untouched
    expect(readFileSync(claudeJson, 'utf8')).toBe(original)

    // Codex was cleaned
    const codexResult = results.find(e => e.target === codexToml)
    expect(codexResult?.status).toBe('removed')
  })
})

// ─── Second run: all absent ───────────────────────────────────────────────────

describe('second run', () => {
  it('returns absent for every target after cleanup', () => {
    // Setup all targets
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'plur-enterprise': {} } }))

    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const codexToml = join(codexDir, 'config.toml')
    writeFileSync(codexToml, '[mcp_servers.plur-enterprise]\ncommand = "npx"\nargs = []\n')

    const opencodeDir = join(home, '.config', 'opencode')
    mkdirSync(opencodeDir, { recursive: true })
    const opencodePath = join(opencodeDir, 'opencode.json')
    writeFileSync(opencodePath, '{"mcp":{"plur-enterprise":{"url":"https://plur.example.com/mcp"}}}')

    const cursorDir = join(home, '.cursor')
    mkdirSync(cursorDir, { recursive: true })
    const cursorMcp = join(cursorDir, 'mcp.json')
    writeFileSync(cursorMcp, JSON.stringify({ mcpServers: { 'plur-enterprise': {} } }))

    const headerPath = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(headerPath, 'Authorization: Bearer plur_sk_test_fake')

    const env = makeEnv()
    const tools: Array<'claude-code' | 'codex' | 'opencode' | 'cursor'> = ['claude-code', 'codex', 'opencode', 'cursor']

    // First run
    cleanupLegacy({ tools, backupDir, plurDir, home, env })

    // Second run: all absent
    const results2 = cleanupLegacy({ tools, backupDir, plurDir, home, env })
    for (const r of results2) {
      expect(r.status).toBe('absent')
    }
  })
})

// ─── Review hardening ─────────────────────────────────────────────────────────

describe('backups and writes', () => {
  it.skipIf(process.platform === 'win32')('creates the backup dir owner-only (0700)', () => {
    writeFileSync(join(plurDir, 'mcp-enterprise-header'), 'Authorization: Bearer plur_sk_test_fake')
    cleanupLegacy({ tools: [], backupDir, plurDir, home })
    expect(statSync(backupDir).mode & 0o777).toBe(0o700)
  })

  it('never overwrites an earlier backup in the same dir', () => {
    const headerPath = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(headerPath, 'first')
    const r1 = cleanupLegacy({ tools: [], backupDir, plurDir, home }).find(e => e.target === headerPath)
    writeFileSync(headerPath, 'second')
    const r2 = cleanupLegacy({ tools: [], backupDir, plurDir, home }).find(e => e.target === headerPath)
    expect(r1?.backup).not.toBe(r2?.backup)
    expect(readFileSync(r1!.backup!, 'utf8')).toBe('first')
    expect(readFileSync(r2!.backup!, 'utf8')).toBe('second')
  })

  it.skipIf(process.platform === 'win32')('a symlinked opencode.json stays a symlink; the target is cleaned', () => {
    const opencodeDir = join(home, '.config', 'opencode')
    mkdirSync(opencodeDir, { recursive: true })
    const real = join(home, 'dotfiles-opencode.json')
    writeFileSync(real, '{"mcp":{"plur":{},"plur-enterprise":{"url":"https://plur.example.com/mcp"}}}')
    const link = join(opencodeDir, 'opencode.json')
    symlinkSync(real, link)
    const r = cleanupLegacy({ tools: ['opencode'], backupDir, plurDir, home, env: makeEnv() }).find(e => e.target === link)
    expect(r?.status).toBe('removed')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).not.toContain('plur-enterprise')
  })

  it.skipIf(process.platform === 'win32')('a rewritten config keeps its mode (0600 stays 0600)', () => {
    const claudeJson = join(home, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'plur-enterprise': {}, plur: {} } }))
    chmodSync(claudeJson, 0o600)
    cleanupLegacy({ tools: ['claude-code'], backupDir, plurDir, home })
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600)
  })

  it('leaves no temp files next to a rewritten config', () => {
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'config.toml'), '[mcp_servers.plur-enterprise]\ncommand = "npx"\n')
    cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env: makeEnv() })
    expect(readdirSync(codexDir)).toEqual(['config.toml'])
  })

  it('a failure on one target is reported as refused and does not stop the others', () => {
    // backupDir is a regular file: no backup can be written, so nothing may be removed
    writeFileSync(backupDir, 'not a dir')
    const headerPath = join(plurDir, 'mcp-enterprise-header')
    writeFileSync(headerPath, 'Authorization: Bearer plur_sk_test_fake')
    const claudeJson = join(home, '.claude.json')
    const original = JSON.stringify({ mcpServers: { 'plur-enterprise': {} } })
    writeFileSync(claudeJson, original)
    const results = cleanupLegacy({ tools: ['claude-code'], backupDir, plurDir, home })
    expect(results.map(r => r.status)).toEqual(['refused', 'refused'])
    expect(readFileSync(claudeJson, 'utf8')).toBe(original)
    expect(existsSync(headerPath)).toBe(true)
  })
})

describe('codex TOML edge cases', () => {
  function writeCodex(text: string): string {
    const codexDir = join(home, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const p = join(codexDir, 'config.toml')
    writeFileSync(p, text)
    return p
  }

  it('keeps the comment that introduces the next kept table', () => {
    const p = writeCodex([
      'model = "o3"',
      '',
      '[mcp_servers.plur-enterprise]',
      'command = "npx"',
      '',
      '# my own server, keep this note',
      '[mcp_servers.other]',
      'command = "other-command"',
      '',
    ].join('\n'))
    const r = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env: makeEnv() }).find(e => e.target === p)
    expect(r?.status).toBe('removed')
    const cleaned = readFileSync(p, 'utf8')
    expect(cleaned).toContain('# my own server, keep this note\n[mcp_servers.other]\ncommand = "other-command"\n')
    expect(cleaned).toContain('model = "o3"')
    expect(cleaned).not.toContain('plur-enterprise')
  })

  it('an inline plur-enterprise entry is refused, never reported absent', () => {
    const text = '[mcp_servers]\nplur-enterprise = { command = "npx", args = [] }\nother = { command = "x" }\n'
    const p = writeCodex(text)
    const r = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env: makeEnv() }).find(e => e.target === p)
    expect(r?.status).toBe('refused')
    expect(readFileSync(p, 'utf8')).toBe(text)
  })

  it('an unparsable config.toml is refused, bytes unchanged, no backup', () => {
    const text = '[mcp_servers.plur-enterprise\ncommand = '
    const p = writeCodex(text)
    const r = cleanupLegacy({ tools: ['codex'], backupDir, plurDir, home, env: makeEnv() }).find(e => e.target === p)
    expect(r?.status).toBe('refused')
    expect(r?.backup).toBeUndefined()
    expect(readFileSync(p, 'utf8')).toBe(text)
  })
})

