import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
import { helloStatement, runHello } from '../src/enterprise/hello.js'
import { runEnterpriseInit } from '../src/enterprise/init.js'
import { realExec, type ExecFn } from '../src/enterprise/exec.js'
import { CLI_VERSION } from '../src/version.js'
import { startEnterpriseContract } from './helpers/contract-server.js'

const facts = { username: 'member', deviceName: 'laptop (macOS)', tools: ['Codex'], version: '0.21.5', date: '2026-10-20' }
it('preserves ordinary device labels and the existing hello format', () => {
  expect(helloStatement(facts)).toBe('PLUR connected: member on laptop (macOS), Codex, PLUR 0.21.5, 2026-10-20')
})
it.each(['workstation.internal (macOS)', 'workstation.local (Linux)'])('omits the sensitive device label %s without mutating sign-in metadata', deviceName => {
  const input = { ...facts, deviceName }
  expect(helloStatement(input)).toBe('PLUR connected: member on private device, Codex, PLUR 0.21.5, 2026-10-20')
  expect(input.deviceName).toBe(deviceName)
})

it.each([false, true])('proves real MCP delivery while retaining whole-message privacy checks (sensitive username=%s)', async sensitiveUser => {
  const dir = mkdtempSync(join(tmpdir(), 'hello-private-device-')), home = join(dir, 'home'), store = join(home, '.plur')
  mkdirSync(store, { recursive: true })
  const server = new StubServer('synthetic-hello-token')
  try {
    const { url } = await server.start()
    server.setMe({ username: 'member', org_id: 'example', scopes: ['user:example:member'] })
    writeFileSync(join(store, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ url, token: 'synthetic-hello-token', scope: 'user:example:member' }] }))
    const statement = helloStatement({ ...facts, deviceName: 'workstation.internal (macOS)', username: sensitiveUser ? 'member.internal' : 'member' })
    expect(statement).not.toContain('workstation.internal')
    const result = await runHello({ serverUrl: url, personalScope: 'user:example:member', statement,
      launches: [{ tool: 'codex', launch: { command: process.execPath, args: [builtCliPath(join(__dirname, '..', '..', 'mcp'))],
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1', PLUR_AUTO_DISCOVER: '0' } } }] })
    expect(result.saved.ok).toBe(!sensitiveUser)
    expect(server.appendStatements).toHaveLength(sensitiveUser ? 0 : 1)
    if (sensitiveUser) {
      expect(result.saved).toMatchObject({ ok: false, reason: expect.stringContaining('privacy check kept sensitive content') })
      expect(result.perTool).toEqual([])
    } else {
      expect(server.appendStatements[0]).toBe(statement)
      // This stub stores POSTs but deliberately returns no recall rows.
      // Sanitizing the label must not turn an absent server recall into proof.
      expect(server.recallCalls).toBeGreaterThan(0)
      expect(result.perTool).toEqual([{ tool: 'codex', recalled: false, reason: "saved, but Codex's environment could not recall it" }])
    }
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }) }
}, 60_000)

it('keeps the original device name in real sign-in requests and stored metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hello-device-metadata-')), home = join(root, 'home'), store = join(home, '.plur'), configPath = join(store, 'config.yaml')
  mkdirSync(store, { recursive: true }); writeFileSync(configPath, JSON.stringify({ index: false, embeddings: { enabled: false } }))
  const contract = await startEnterpriseContract()
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'), PLUR_PATH: store, PLUR_AUTO_DISCOVER: '0' }
    const exec: ExecFn = (command, args, options) => {
      if (!args.includes('init')) return realExec(command, args, options)
      const fixture = join(root, 'packages/mcp/dist/index.js')
      mkdirSync(join(root, 'packages/mcp/dist'), { recursive: true }); writeFileSync(join(root, 'package.json'), '{"type":"module"}')
      writeFileSync(fixture, `import ${JSON.stringify(pathToFileURL(join(__dirname, 'helpers/contract-mcp-server.mjs')).href)}\n`)
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { plur: { command: process.execPath, args: [fixture], env: { FIXTURE_SERVER: contract.url, FIXTURE_CONFIG: configPath, FIXTURE_VERSION: CLI_VERSION } } } }))
      return { status: 0, stdout: 'Claude registered' }
    }
    let signedDevice: string | undefined
    const result = await runEnterpriseInit({ server: contract.url, mode: 'full', tokenStdin: false, json: true, noBrowser: true }, {
      home, env, exec, sleep: async () => {}, hostname: () => 'workstation.internal', platform: 'darwin', print: () => {}, cliEntry: join(root, 'fixture-cli.js'),
      fetch: async (input, init) => { if (String(input).endsWith('/api/v1/auth/device')) signedDevice = JSON.parse(String(init?.body)).device_name; return fetch(input, init) },
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(signedDevice).toBe('workstation.internal (macOS)')
    const config = yaml.load(readFileSync(configPath, 'utf8')) as any
    expect(config.stores[0].enterprise.device_name).toBe('workstation.internal (macOS)')
    expect(contract.state.writes).toHaveLength(1)
    expect(contract.state.writes[0].statement).toContain(' on private device, ')
    expect(contract.state.writes[0].statement).not.toContain('workstation.internal')
  } finally { await contract.close(); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
