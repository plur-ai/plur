import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readCodexEntry, patchCodexEntry, updateCodexRegistration, codexLaunchKind, codexMcpEnvironment, olderOrEqual } from '../src/codex-config.js'

const replacement = { command: '/installed/plur-mcp', args: [] }
const pin = '[mcp_servers.plur]\ncommand = "npx"\nargs = ["-y", "@plur-ai/mcp@0.19.4"]\n'
let root: string, path: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plur-codex-upgrade-'))
  path = join(root, 'config.toml')
  writeFileSync(join(root, 'config.yaml'), 'stores:\n  - url: http://127.0.0.1:9999\n    token_env: TEST_REMOTE_TOKEN\n    scope: group:fixture/eng\n')
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
const update = (extra = {}) => updateCodexRegistration({ root, path, version: '0.21.5', replacement, ...extra })

describe('Codex upgrades preserve user configuration (#1623)', () => {
  it('upgrades an old pin without losing env, tools, cwd, comments or unrelated tables; rerun is idempotent', () => {
    const suffix = 'cwd = "/project"\nstartup_timeout_sec = 37\n# keep policy\n[mcp_servers.plur.env]\nEXISTING = "synthetic"\n[mcp_servers.plur.tools.plur_learn]\napproval_mode = "prompt"\n[profiles.work]\nmodel = "fixture"\n'
    writeFileSync(path, '# header\n' + pin + suffix)
    expect(update().status).toBe('updated')
    const first = readFileSync(path, 'utf8')
    expect(first).toContain(suffix)
    expect(first).toContain('# header\n')
    expect(readCodexEntry(first)).toMatchObject({ ...replacement, env_vars: ['TEST_REMOTE_TOKEN'], env: { EXISTING: 'synthetic' } })
    expect(update().status).toBe('custom') // arbitrary replacement here is intentionally not claimed as PLUR-owned
    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it.each([
    '[mcp_servers."plur"]\ncommand = "npx"\nargs = [\n "-y", # retain argument comment\n "@plur-ai/mcp@0.19.4",\n]\nenv_vars = [\n { name = "EXISTING", source = "local" }, # retain forwarding comment\n]\n',
    'mcp_servers.plur = { command = "npx", args = ["-y", "@plur-ai/mcp@0.19.4"], env = { EXISTING = "x" } }\n',
    '[mcp_servers]\nplur.command = "npx"\nplur.args = ["-y", "@plur-ai/mcp@0.19.4"]\n',
    'mcp_servers.plur.command = "npx"\nmcp_servers.plur.args = ["-y", "@plur-ai/mcp@0.19.4"]',
    pin.replaceAll('\n', '\r\n'),
  ])('handles valid TOML shapes without flattening configuration (%#)', original => {
    writeFileSync(path, original)
    expect(update().status).toBe('updated')
    const next = readFileSync(path, 'utf8')
    expect(readCodexEntry(next)).toMatchObject(replacement)
    expect(readCodexEntry(next)?.env_vars).toContain('TEST_REMOTE_TOKEN')
    for (const comment of ['# retain argument comment', '# retain forwarding comment']) if (original.includes(comment)) expect(next).toContain(comment)
    if (original.includes('\r\n')) expect(next.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it.each(['0.22.0', '1.0.0'])('does not downgrade newer pin %s', version => {
    writeFileSync(path, pin.replace('0.19.4', version))
    update()
    expect(readCodexEntry(readFileSync(path, 'utf8'))?.args).toContain('@plur-ai/mcp@' + version)
  })
  it('keeps an intentional old pin while repairing forwarding', () => {
    writeFileSync(path, pin)
    update({ keepLaunch: true })
    expect(readCodexEntry(readFileSync(path, 'utf8'))).toMatchObject({ command: 'npx', args: ['-y', '@plur-ai/mcp@0.19.4'], env_vars: ['TEST_REMOTE_TOKEN'] })
    expect(update({ keepLaunch: true }).status).toBe('unchanged')
  })
  it.each([
    '[mcp_servers.plur]\nurl = "https://example.test/mcp"\n',
    pin.replace('"npx"', '"custom-launcher"'),
    pin.replace('0.19.4', 'canary'),
    pin.replace('@plur-ai/mcp@0.19.4', '@someone/fork@0.19.4'),
  ])('preserves remote/custom registrations byte for byte (%#)', original => {
    writeFileSync(path, original)
    expect(update().status).toBe('custom')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
  it.each(['[mcp_servers.plur\nsecret = "synthetic-secret"', pin + 'args = []\n'])('refuses malformed/duplicate TOML without revealing its contents (%#)', original => {
    writeFileSync(path, original)
    expect(() => update()).toThrow('not valid TOML')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
  it('uses the registered PLUR_PATH, not a different CLI store', () => {
    const other = join(root, 'other'); mkdirSync(other)
    writeFileSync(join(other, 'config.yaml'), 'stores: []\n')
    writeFileSync(path, pin + `env = { PLUR_PATH = ${JSON.stringify(other)} }\n`)
    update()
    expect(readCodexEntry(readFileSync(path, 'utf8'))?.env_vars).toBeUndefined()
  })
  it('keeps inline token overrides and never copies the parent token value', () => {
    vi.stubEnv('TEST_REMOTE_TOKEN', 'parent-synthetic-secret')
    writeFileSync(path, pin + 'env = { TEST_REMOTE_TOKEN = "inline-synthetic-secret" }\n')
    update()
    const next = readFileSync(path, 'utf8')
    expect(next).not.toContain('parent-synthetic-secret')
    expect(readCodexEntry(next)?.env_vars).toBeUndefined()
    expect(readCodexEntry(next)?.env?.TEST_REMOTE_TOKEN).toBe('inline-synthetic-secret')
  })
  it('preserves explicit remote source entries', () => {
    const original = pin + 'env_vars = [{ name = "TEST_REMOTE_TOKEN", source = "remote" }]\n'
    writeFileSync(path, original)
    update()
    expect(readCodexEntry(readFileSync(path, 'utf8'))?.env_vars).toEqual([{ name: 'TEST_REMOTE_TOKEN', source: 'remote' }])
  })
  it.each([
    { command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp@0.19.4'] },
    { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.19.4'] },
    { command: 'npx.cmd', args: ['-y', '@plur-ai/mcp@latest'] },
  ])('recognizes previously shipped launch forms (%#)', entry => expect(codexLaunchKind(entry, '0.21.5')).toBe('upgrade'))
  it('does not claim arbitrary shell commands', () => expect(codexLaunchKind({ command: '/bin/sh', args: ['-lc', 'npx -y @plur-ai/mcp@0.19.4; other'] }, '0.21.5')).toBe('custom'))
  it('appends to an empty commented env_vars array', () => {
    const next = patchCodexEntry(pin + 'env_vars = [\n# comment\n]\n', { env_vars: ['TEST_REMOTE_TOKEN'] })
    expect(next).toContain('# comment')
    expect(readCodexEntry(next)?.env_vars).toEqual(['TEST_REMOTE_TOKEN'])
  })
})

describe('Codex environment filtering', () => {
  const entry = { command: 'node', args: [] }
  it('does not infer MCP token availability from the parent shell alone', () => {
    expect(codexMcpEnvironment(entry, { HOME: '/home/test', PATH: '/bin', TEST_REMOTE_TOKEN: 'synthetic' }, false)).toEqual({ HOME: '/home/test', PATH: '/bin' })
    expect(codexMcpEnvironment({ ...entry, env_vars: ['TEST_REMOTE_TOKEN'] }, { TEST_REMOTE_TOKEN: 'synthetic' }, false).TEST_REMOTE_TOKEN).toBe('synthetic')
  })
  it('forwards local object entries and applies inline overrides', () => {
    expect(codexMcpEnvironment({ ...entry, env_vars: [{ name: 'TOKEN', source: 'local' }], env: { TOKEN: 'inline' } }, { TOKEN: 'parent' }, false).TOKEN).toBe('inline')
  })
  it('preserves mixed-case Windows system variables and overrides without duplicates', () => {
    const env = codexMcpEnvironment({ ...entry, env: { PATH: 'new' } }, { Path: 'old', SystemRoot: 'C:\\Windows', AppData: 'C:\\Profile', SECRET: 'x' }, true)
    expect(env).toEqual({ PATH: 'new', SystemRoot: 'C:\\Windows', AppData: 'C:\\Profile' })
  })
  it('resolves inherited certificate files before a server changes cwd', () => {
    const env = codexMcpEnvironment(entry, { NODE_EXTRA_CA_CERTS: 'fixture.pem', SSL_CERT_DIR: '/not-implicitly-forwarded' }, false)
    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(process.cwd(), 'fixture.pem'))
    expect(env).not.toHaveProperty('SSL_CERT_DIR')
  })
  it('refuses remote-source inheritance for local stdio', () => expect(() => codexMcpEnvironment({ ...entry, env_vars: [{ name: 'TOKEN', source: 'remote' }] })).toThrow('remote stdio'))
  it('does not pass Codex non-inheritable variables even if explicitly requested', () => expect(codexMcpEnvironment({ ...entry, env: { NODE_REPL_AUTH_TOKEN: 'synthetic' } })).not.toHaveProperty('NODE_REPL_AUTH_TOKEN'))
})

describe('version ordering', () => {
  it.each([
    ['0.19.4', '0.21.4-ci.fixture', true],
    ['0.21.4', '0.21.4-ci.fixture', false],
    ['0.21.5-rc.2', '0.21.5-rc.10', true],
    ['0.21.5', '0.21.5-rc.1', false],
    ['0.21.5-rc.1', '0.21.5', true],
    ['0.21.6', '0.21.5', false],
  ])('%s <= %s is %s', (a, b, expected) => expect(olderOrEqual(a, b)).toBe(expected))
})
