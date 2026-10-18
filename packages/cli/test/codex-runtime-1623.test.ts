import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { readCodexEntry } from '../src/codex-config.js'
import { CLI_VERSION } from '../src/version.js'
const CLI = builtCliPath(join(__dirname, '..'))
let home: string, config: string, fakeMcp: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-codex-runtime-'))
  mkdirSync(join(home, '.codex')); mkdirSync(join(home, '.plur'))
  config = join(home, '.codex', 'config.toml')
  fakeMcp = join(home, 'fixture.mjs')
  writeFileSync(fakeMcp, `
    import readline from 'node:readline';
    readline.createInterface({input: process.stdin}).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{serverInfo:{name:'fixture',version:process.env.FIXTURE_VERSION || '${CLI_VERSION}'}}}));
      if (r.method === 'tools/list') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'plur_learn'}]}}));
    });
  `)
  writeFileSync(join(home, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nstores:\n  - url: http://127.0.0.1:9999\n    token_env: TEST_REMOTE_TOKEN\n    scope: group:fixture/eng\n')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...env }, encoding: 'utf8', timeout: 45000 })
}
function register(extra = '') {
  writeFileSync(config, `[mcp_servers.plur]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fakeMcp)}]\n${extra}`)
}
const initArgs = ['init', '--global', '--codex', '--no-desktop', '--no-cursor', '--no-antigravity', '--no-opencode', '--no-prompt']

describe('built Codex init and doctor (#1623)', { timeout: 60000 }, () => {
  it('init upgrades a seeded 0.19.4 pin, forwards existing stores, and a second init preserves bytes', () => {
    writeFileSync(config, '[mcp_servers.plur]\ncommand = "npx"\nargs = ["-y", "@plur-ai/mcp@0.19.4"]\nstartup_timeout_sec = 37\n[profiles.fixture]\nmodel = "fixture"\n')
    const first = run(initArgs, { TEST_REMOTE_TOKEN: 'synthetic-not-persisted' })
    expect(first.status, first.stdout + first.stderr).toBe(0)
    const bytes = readFileSync(config, 'utf8')
    expect(bytes).not.toContain('0.19.4')
    expect(bytes).not.toContain('synthetic-not-persisted')
    expect(bytes).toContain('startup_timeout_sec = 37\n[profiles.fixture]\nmodel = "fixture"')
    expect(readCodexEntry(bytes)?.env_vars).toEqual(['TEST_REMOTE_TOKEN'])
    const second = run(initArgs)
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe(bytes)
  })
  it('explicit keep flag preserves an old pin', () => {
    writeFileSync(config, '[mcp_servers.plur]\ncommand = "npx"\nargs = ["-y", "@plur-ai/mcp@0.19.4"]\n')
    expect(run([...initArgs, '--keep-codex-mcp']).status).toBe(0)
    expect(readCodexEntry(readFileSync(config, 'utf8'))?.args).toContain('@plur-ai/mcp@0.19.4')
  })
  it('doctor fails for missing forwarding even when the terminal has the token', () => {
    register()
    const result = run(['doctor', '--codex', '--json'], { TEST_REMOTE_TOKEN: 'synthetic-hidden' })
    const report = JSON.parse(result.stdout)
    expect(result.status).toBe(1)
    expect(report.handshake.ok).toBe(true)
    expect(report.tokenVariables).toEqual([{ name: 'TEST_REMOTE_TOKEN', available: false, fix: expect.stringContaining('env_vars') }])
    expect(result.stdout + result.stderr).not.toContain('synthetic-hidden')
  })
  it('doctor distinguishes a missing parent token from missing forwarding', () => {
    register('env_vars = ["TEST_REMOTE_TOKEN"]\n')
    const result = run(['doctor', '--codex', '--json'], { TEST_REMOTE_TOKEN: '' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).tokenVariables[0].fix).toContain('environment that launches Codex')
  })
  it('doctor passes the declared MCP and forwards the token; it states desktop is outside this check', () => {
    register('env_vars = ["TEST_REMOTE_TOKEN"]\n')
    const result = run(['doctor', '--codex', '--json'], { TEST_REMOTE_TOKEN: 'synthetic' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.versionMatches).toBe(true)
    expect(report.tokenVariables[0].available).toBe(true)
    expect(report.verificationScope).toContain('desktop environment')
  })
  it('doctor cannot hide a stale Codex runtime behind a working Claude registration', () => {
    register('env_vars = ["TEST_REMOTE_TOKEN"]\nenv = { FIXTURE_VERSION = "0.19.4" }\n')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { plur: { command: process.execPath, args: [fakeMcp] } } }))
    const result = run(['doctor', '--codex', '--json'], { TEST_REMOTE_TOKEN: 'synthetic' })
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.handshake.serverVersion).toBe('0.19.4')
    expect(report.versionMatches).toBe(false)
  })
  it('doctor refuses to declare runtime verified when handshake was skipped', () => {
    register('env_vars = ["TEST_REMOTE_TOKEN"]\n')
    const result = run(['doctor', '--codex', '--no-handshake', '--json'], { TEST_REMOTE_TOKEN: 'synthetic' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).overall).toBe('unverified')
  })
  it('doctor fails without a Codex registration even if another editor works', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { plur: { command: process.execPath, args: [fakeMcp] } } }))
    const result = run(['doctor', '--codex', '--json'])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).registered).toBe(false)
  })
  it('invalid TOML fails init safely, with a nonzero exit and no token disclosure', () => {
    const original = '[mcp_servers.plur]\nsecret = "synthetic-secret" invalid\n'
    writeFileSync(config, original)
    const result = run(initArgs)
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('synthetic-secret')
    expect(readFileSync(config, 'utf8')).toBe(original)
  })
})
