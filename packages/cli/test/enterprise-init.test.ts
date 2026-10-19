import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import yaml from 'js-yaml'
import { realExec, type ExecFn } from '../src/enterprise/exec.js'
import { CLI_VERSION } from '../src/version.js'
import { formatSummary } from '../src/enterprise/summary.js'
import { startEnterpriseContract } from './helpers/contract-server.js'

let root: string, home: string, store: string, configPath: string, contract: Awaited<ReturnType<typeof startEnterpriseContract>>
let modes: { recallMiss?: boolean; wrongVersion?: boolean; initFails?: boolean; concurrentEdit?: boolean }, browserCalls: number, env: NodeJS.ProcessEnv
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-enterprise-init-'))); home = join(root, 'home'); store = join(home, '.plur'); configPath = join(store, 'config.yaml')
  mkdirSync(store, { recursive: true }); writeFileSync(configPath, JSON.stringify({ index: false, embeddings: { enabled: false } }))
  contract = await startEnterpriseContract(); modes = {}; browserCalls = 0
  env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'), PLUR_PATH: store, OPENCODE_CONFIG_DIR: join(home, '.config/opencode'), PLUR_AUTO_DISCOVER: '0' }
})
afterEach(async () => { await contract.close(); rmSync(root, { recursive: true, force: true }) })
const config = () => yaml.load(readFileSync(configPath, 'utf8')) as any
const exec: ExecFn = (command, args, options) => {
  if (!args.includes('init')) return realExec(command, args, options)
  if (modes.concurrentEdit) writeFileSync(configPath, yaml.dump({ ...config(), concurrent_setting: 'preserve me' }))
  if (modes.initFails) return { status: 1, stdout: 'fixture init failure' }
  const fixtureEnv = { FIXTURE_SERVER: contract.url, FIXTURE_CONFIG: configPath, FIXTURE_VERSION: CLI_VERSION }
  const fixture = join(root, 'packages/mcp/dist/index.js')
  mkdirSync(join(root, 'packages/mcp/dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(fixture, `import ${JSON.stringify(pathToFileURL(join(__dirname, 'helpers/contract-mcp-server.mjs')).href)}\n`)
  mkdirSync(env.CODEX_HOME!, { recursive: true }); mkdirSync(env.OPENCODE_CONFIG_DIR!, { recursive: true })
  writeFileSync(join(env.CODEX_HOME!, 'config.toml'), `[mcp_servers.plur]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\n[mcp_servers.plur.env]\n` + Object.entries({ ...fixtureEnv, ...(modes.wrongVersion ? { FIXTURE_VERSION: '0.0.1' } : {}) }).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n') + '\n')
  writeFileSync(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), JSON.stringify({ mcp: { plur: { type: 'local', command: [process.execPath, fixture], environment: { ...fixtureEnv, ...(modes.recallMiss ? { FIXTURE_RECALL_MISS: '1' } : {}) } }, 'plur-enterprise': { type: 'remote', url: contract.url + '/mcp' } } }))
  return { status: 0, stdout: 'fixture init' }
}
async function run(overrides: Record<string, unknown> = {}, extraDeps = {}) {
  const { runEnterpriseInit } = await import('../src/enterprise/init.js')
  return runEnterpriseInit({ server: contract.url, mode: 'full', tokenStdin: false, json: false, noBrowser: false, ...overrides }, {
    home, env, exec, fetch, sleep: async () => {}, hostname: () => 'fixture-device', platform: process.platform,
    print: () => {}, openBrowser: async () => { browserCalls++; return true }, cliEntry: join(root, 'fixture-cli.js'), ...extraDeps,
  })
}
it('signs in, wires both tools, proves actual server save/recall and removes only proven legacy entries', async () => {
  const result = await run()
  expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.signIn).toMatchObject({ username: 'member', reused: false })
  expect(contract.state.writes).toHaveLength(1); expect(contract.state.reads).toBe(2)
  expect(result.tools.map(t => [t.tool, t.proven])).toEqual([['codex', true], ['opencode', true]])
  expect(config().stores[0].enterprise.hello_engram_id).toBe(contract.state.writes[0].id)
  expect(JSON.parse(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), 'utf8')).mcp).not.toHaveProperty('plur-enterprise')
  expect(JSON.stringify(result)).not.toContain(contract.state.token)
})
it('reuses a working key and supersedes the previous hello without retiring it', async () => {
  expect((await run()).ok).toBe(true); const previous = contract.state.writes[0].id
  const result = await run()
  expect(result.ok).toBe(true); expect(result.signIn.reused).toBe(true); expect(contract.state.deviceRequests).toBe(1)
  expect(contract.state.writes[1].supersedes).toEqual([previous]); expect(contract.state.writes[0].status).toBe('active')
})
it('stops on an uncertain existing-key check without changing configuration or authorizing again', async () => {
  await run(); const before = readFileSync(configPath); contract.state.meStatus = 503
  const result = await run()
  expect(result.ok).toBe(false); expect(result.failure?.step).toBe('sign-in')
  expect(readFileSync(configPath)).toEqual(before); expect(contract.state.deviceRequests).toBe(1)
  expect(result.failure?.message).toContain('503')
  expect(result.failure?.message).toContain('Nothing was changed')
})
it('replaces a rejected key without duplicating its server entry', async () => {
  await run(); contract.state.rejectToken = contract.state.token; contract.state.token = 'plur_sk_' + 'b'.repeat(32)
  const result = await run()
  expect(result.ok).toBe(true); expect(result.signIn.reused).toBe(false); expect(contract.state.deviceRequests).toBe(2)
  expect(config().stores.filter((s: any) => s.url === contract.url)).toHaveLength(1)
  expect(result.flushed).toBeDefined()
})
it('rolls a newly minted key back when installation fails before attempting a save', async () => {
  const before = readFileSync(configPath); modes.initFails = true
  const result = await run()
  expect(result.ok).toBe(false); expect(contract.state.writes).toEqual([])
  expect(readFileSync(configPath)).toEqual(before)
})
it('preserves another process configuration change instead of restoring a stale backup', async () => {
  modes.initFails = true; modes.concurrentEdit = true
  const result = await run()
  expect(result.ok).toBe(false); expect(config().concurrent_setting).toBe('preserve me')
  expect(result.failure?.message).toContain('changed')
  expect(result.backupDir).toBeDefined()
})
it('preserves configuration changed during scope discovery before the later rollback snapshot', async () => {
  contract.state.duringDiscovery = () => writeFileSync(configPath, yaml.dump({ ...config(), concurrent_setting: 'written during discovery' }))
  modes.initFails = true
  const result = await run()
  expect(result.ok).toBe(false); expect(config().concurrent_setting).toBe('written during discovery')
  expect(result.failure?.message).toContain('changed')
})
it('can restore its own metadata discovery writes when installation fails before saving', async () => {
  const before = readFileSync(configPath)
  contract.state.metadata = true; modes.initFails = true
  const result = await run()
  expect(result.ok).toBe(false); expect(contract.state.writes).toEqual([])
  expect(readFileSync(configPath)).toEqual(before)
})
it('keeps the key when an MCP error does not prove whether the server saved', async () => {
  const before = readFileSync(configPath); contract.state.saveStatus = 403
  const result = await run()
  expect(result.ok).toBe(false); expect(result.hello?.saved.ok).toBe(false)
  expect(readFileSync(configPath)).not.toEqual(before)
  expect(config().stores[0].token).toBe(contract.state.token)
  expect(JSON.parse(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), 'utf8')).mcp).toHaveProperty('plur-enterprise')
})
it('keeps the key when the server saves but loses the response', async () => {
  contract.state.loseSaveReply = true
  const result = await run()
  expect(result.ok).toBe(false); expect(contract.state.writes).toHaveLength(1)
  expect(config().stores[0].token).toBe(contract.state.token)
  expect(result.hello?.saved.ok).toBe(false)
})
it('keeps an accepted save and leaves the unproven tool legacy entry intact', async () => {
  modes.recallMiss = true
  const result = await run()
  expect(result.ok).toBe(false); expect(result.hello?.saved.ok).toBe(true)
  expect(config().stores[0].enterprise.hello_engram_id).toBe(contract.state.writes[0].id)
  expect(result.tools.find(t => t.tool === 'opencode')?.proven).toBe(false)
  expect(JSON.parse(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), 'utf8')).mcp).toHaveProperty('plur-enterprise')
})
it('refuses the wrong tool version and preserves that tool configuration', async () => {
  modes.wrongVersion = true
  const result = await run()
  expect(result.ok).toBe(false); expect(result.tools.find(t => t.tool === 'codex')?.version?.ok).toBe(false)
  expect(formatSummary(result).join('\n')).toContain('0.0.1')
})
it('checks 120 authorized project scopes in ordered chunks of 50, 50, 20', async () => {
  contract.state.scopes = ['user:example:member', ...Array.from({ length: 120 }, (_, i) => `project:example/team/p${i}`)]
  const result = await run()
  expect(result.ok).toBe(true); expect(contract.state.writeChunks.map(c => c.length)).toEqual([50, 50, 20])
  expect(result.writeCheck.map(r => r.scope)).toEqual(contract.state.scopes.slice(1))
})
it('skips a write check with no team scopes and suppresses the browser in remote SSH', async () => {
  contract.state.scopes = ['user:example:member']; env.SSH_CONNECTION = 'fixture'; env.VSCODE_IPC_HOOK_CLI = 'fixture'
  const result = await run()
  expect(result.ok).toBe(true); expect(browserCalls).toBe(0); expect(contract.state.writeChunks).toEqual([])
  expect(formatSummary(result).join('\n')).toContain('nothing to check')
  expect(formatSummary(result).join('\n')).toContain('VS Code Remote-SSH')
})
it('does not accept a malformed write-check response as a green result', async () => {
  contract.state.malformedWriteCheck = true
  const result = await run()
  expect(result.ok).toBe(false)
  expect(result.failure?.message).toContain('write check')
  expect(formatSummary(result).join('\n')).not.toContain('no team or project scopes')
})
it('does not claim empty team scope discovery when the discovery request failed', async () => {
  contract.state.failDiscovery = true
  const result = await run()
  expect(result.ok).toBe(false)
  expect(formatSummary(result).join('\n')).not.toContain('no team or project scopes')
})
it('names the existing personal-scope holder and offers explicit recovery without taking it over', async () => {
  writeFileSync(configPath, yaml.dump({ ...config(), stores: [{ scope: 'user:example:Member', url: 'https://old.example.invalid', token: 'fixture-old-key' }] }))
  const before = readFileSync(configPath)
  const result = await run()
  expect(result.ok).toBe(false); expect(readFileSync(configPath)).toEqual(before)
  expect(result.failure?.message).toContain('--remove-stale')
  expect(result.failure?.message).toContain('user:example:member')
})
it('accepts a stdin key using the same 16-character minimum as device sign-in without authorizing', async () => {
  contract.state.token = 'plur_sk_' + 'a'.repeat(16)
  const result = await run({ tokenStdin: true }, { readToken: async () => contract.state.token + '\n' })
  expect(result.ok).toBe(true); expect(contract.state.deviceRequests).toBe(0)
  expect(JSON.stringify(result)).not.toContain(contract.state.token)
})
it('names an unsynced account when the save is refused and retains its unconfirmed key', async () => {
  contract.state.discovery = 'not_synced'; contract.state.scopes = []; contract.state.saveStatus = 403
  const result = await run()
  expect(result.ok).toBe(false); expect(result.hello?.saved).toMatchObject({ ok: false, reason: 'not_synced' })
  expect(formatSummary(result).join('\n')).toContain('not set up on the server yet')
})
