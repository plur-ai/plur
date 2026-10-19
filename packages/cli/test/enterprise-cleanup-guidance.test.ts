import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import yaml from 'js-yaml'
import { runEnterpriseInit } from '../src/enterprise/init.js'
import { realExec, type ExecFn } from '../src/enterprise/exec.js'
import { CLI_VERSION } from '../src/version.js'
import { startEnterpriseContract } from './helpers/contract-server.js'

let root: string
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

it.each(['legacy entry', 'unreadable configuration'])('explains retained %s after a proven save without exposing raw cleanup details', async kind => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-cleanup-guidance-')))
  const home = join(root, 'home'), store = join(home, '.plur'), configPath = join(store, 'config.yaml')
  mkdirSync(store, { recursive: true }); mkdirSync(join(home, '.codex'))
  writeFileSync(configPath, JSON.stringify({ index: false, embeddings: { enabled: false } }))
  const legacy = kind === 'legacy entry' ? '[mcp_servers.plur-enterprise]\ncommand = "mcp-remote"\n' : '[private-parser-marker\n'
  const header = 'Authorization: Bearer private-header-marker\n'
  writeFileSync(join(home, '.codex/config.toml'), legacy)
  writeFileSync(join(store, 'mcp-enterprise-header'), header)
  const contract = await startEnterpriseContract()
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'), PLUR_PATH: store, PLUR_AUTO_DISCOVER: '0' }
    // Model init detecting only Claude. Cleanup, orchestration, and the
    // save/recall exchange run normally; no cleanup result is substituted.
    const exec: ExecFn = (command, args, options) => {
      if (!args.includes('init')) return realExec(command, args, options)
      const fixture = join(root, 'packages/mcp/dist/index.js')
      mkdirSync(join(root, 'packages/mcp/dist'), { recursive: true })
      writeFileSync(join(root, 'package.json'), '{"type":"module"}')
      writeFileSync(fixture, `import ${JSON.stringify(pathToFileURL(join(__dirname, 'helpers/contract-mcp-server.mjs')).href)}\n`)
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { plur: { command: process.execPath, args: [fixture], env: { FIXTURE_SERVER: contract.url, FIXTURE_CONFIG: configPath, FIXTURE_VERSION: CLI_VERSION } } } }))
      return { status: 0, stdout: 'Only Claude registered' }
    }
    const result = await runEnterpriseInit({ server: contract.url, mode: 'full', tokenStdin: false, json: true, noBrowser: true }, {
      home, env, exec, fetch, sleep: async () => {}, hostname: () => 'fixture-device', print: () => {}, cliEntry: join(root, 'fixture-cli.js'),
    })
    expect(result.ok).toBe(false)
    expect(result.hello?.saved.ok).toBe(true)
    expect(contract.state.writes).toHaveLength(1)
    expect(result.tools.map(t => [t.tool, t.proven])).toEqual(kind === 'legacy entry' ? [['claude-code', true]] : [['claude-code', true], ['codex', false]])
    const config = yaml.load(readFileSync(configPath, 'utf8')) as any
    expect(config.stores[0].token).toBe(contract.state.token)
    expect(config.stores[0].enterprise.hello_engram_id).toBe(contract.state.writes[0].id)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(legacy)
    expect(readFileSync(join(store, 'mcp-enterprise-header'), 'utf8')).toBe(header)
    expect(result.writeCheckState).toBe('pending'); expect(contract.state.writeChunks).toEqual([])
    expect(result.failure?.message).toContain('Legacy configuration was kept')
    expect(result.failure?.message).toContain('install any missing editor')
    expect(result.failure?.message).toContain('init.log')
    expect(result.failure?.message).not.toContain('connection or server write check')
    for (const secret of [contract.state.token, 'private-header-marker', 'private-parser-marker']) expect(JSON.stringify(result)).not.toContain(secret)
  } finally { await contract.close() }
}, 30_000)
