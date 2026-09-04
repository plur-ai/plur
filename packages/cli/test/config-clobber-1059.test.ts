import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { readConfigForWrite } from '../src/mcp-config.js'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * #1059: `plur init` used to read an unparseable harness MCP config as `{}`
 * and write the merge result back — one trailing comma in
 * mcp_config.json and every other MCP server the user had registered was
 * silently destroyed, while the report said "registered". The hooks legs of
 * the same functions have refused this since the 0.19.0 adversarial audit
 * (ADV-F2); these tests pin the refusal onto the MCP legs.
 */

describe('readConfigForWrite', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cfw-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('treats a missing file as a fresh install', () => {
    expect(readConfigForWrite(join(dir, 'nope.json'))).toEqual({ config: {}, ok: true })
  })

  it('returns the parsed object for valid JSON', () => {
    const p = join(dir, 'c.json')
    writeFileSync(p, '{"mcpServers":{"github":{"command":"npx"}}}')
    const { config, ok } = readConfigForWrite(p)
    expect(ok).toBe(true)
    expect((config.mcpServers as Record<string, unknown>).github).toBeDefined()
  })

  it.each([
    ['trailing comma', '{"mcpServers":{"a":{},}}'],
    ['torn file', '{"mcpServers":{"a"'],
    ['array', '["not","a","config"]'],
    ['string', '"just a string"'],
  ])('refuses to hand back a writable config for: %s', (_label, content) => {
    const p = join(dir, 'c.json')
    writeFileSync(p, content)
    expect(readConfigForWrite(p).ok).toBe(false)
  })
})

describe('plur init --antigravity against a damaged mcp_config.json (the #1059 repro)', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-1059-home-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  // The audit's exact reproduction: two real servers and one trailing comma.
  const DAMAGED =
    '{\n' +
    '  "mcpServers": {\n' +
    '    "github":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },\n' +
    '    "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"] },\n' +
    '  }\n' +
    '}\n'

  it('leaves the file byte-identical and says so, instead of clobbering it', () => {
    const cfgDir = join(home, '.gemini', 'config')
    mkdirSync(cfgDir, { recursive: true })
    const mcpPath = join(cfgDir, 'mcp_config.json')
    writeFileSync(mcpPath, DAMAGED)

    let out = ''
    try {
      out = execSync(`node ${CLI} init --antigravity --no-prompt --no-cursor --no-desktop`, {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: join(home, '.plur') },
      })
    } catch (err) {
      out = String((err as { stdout?: unknown }).stdout ?? '')
    }

    // The user's damaged-but-recoverable file survives untouched...
    expect(readFileSync(mcpPath, 'utf8')).toBe(DAMAGED)
    // ...the report says why instead of claiming success...
    expect(out).toMatch(/not valid JSON/)
    expect(out).not.toMatch(/MCP server:\s+registered/)
    // ...and the hooks leg still completed (the refusal is per-leg, not global).
    expect(existsSync(join(cfgDir, 'hooks.json'))).toBe(true)
  })
})

describe('plur init against a damaged ~/.claude/settings.json (evaluator audit, finding 1)', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-1059-settings-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  // The most hand-edited config of them all: permissions, a user hook, a
  // second MCP server — and one trailing comma.
  const DAMAGED =
    '{\n' +
    '  "permissions": { "allow": ["Bash(npm run *)"] },\n' +
    '  "hooks": { "Stop": [ { "hooks": [{ "type": "command", "command": "./my-precious-hook.sh" }] } ] },\n' +
    '  "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }, },\n' +
    '}\n'

  it('leaves the file byte-identical and reports the refusal', () => {
    const dir = join(home, '.claude')
    mkdirSync(dir, { recursive: true })
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, DAMAGED)

    let out = ''
    try {
      out = execSync(`node ${CLI} init --global --no-prompt --no-cursor --no-desktop --no-codex --no-antigravity`, {
        encoding: 'utf-8', timeout: 30000, cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: join(home, '.plur') },
      })
    } catch (err) {
      out = String((err as { stdout?: unknown }).stdout ?? '')
    }

    expect(readFileSync(settingsPath, 'utf8')).toBe(DAMAGED)
    expect(out).toMatch(/not a JSON object/)
  })
})
