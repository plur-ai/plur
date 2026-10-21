import { afterEach, beforeEach, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn, spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { Plur } from '@plur-ai/core'
import { runEnterpriseInit } from '../src/enterprise/init.js'
import { type ExecFn } from '../src/enterprise/exec.js'
import { CLI_VERSION } from '../src/version.js'
import { formatSummary } from '../src/enterprise/summary.js'
import { builtCliPath } from './helpers/built-cli.js'
import { migrationServer } from './helpers/migration-server.js'

const CLI = builtCliPath(join(__dirname, '..'))
let root: string, home: string, store: string, env: NodeJS.ProcessEnv, contract: Awaited<ReturnType<typeof migrationServer>>
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-upgrade-'))); home = join(root, 'home'); store = join(home, '.plur')
  mkdirSync(store, { recursive: true }); contract = await migrationServer()
  env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'), PLUR_PATH: store, PLUR_AUTO_DISCOVER: '0', PLUR_RERANKER: 'off' }
  cpSync(join(__dirname, 'fixtures/enterprise/home-0194'), home, { recursive: true })
  writeFileSync(join(store, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ url: contract.url, token: contract.state.oldKey, scope: 'user:example:member' }] }))
  writeFileSync(join(store, 'mcp-enterprise-header'), `Authorization: Bearer ${contract.state.oldKey}\n`)
})
afterEach(async () => { await contract.close(); rmSync(root, { recursive: true, force: true }) })
const config = () => yaml.load(readFileSync(join(store, 'config.yaml'), 'utf8')) as any
const options = () => ({ server: contract.url, mode: 'full' as const, tokenStdin: false, json: true, noBrowser: true })
// The production init command writes project instructions in its working
// directory. Keep that real execution inside the disposable fixture too.
const isolatedExec: ExecFn = (command, args, opts) => {
  const r = spawnSync(command, args, { cwd: home, env: opts?.env, input: opts?.input, encoding: 'utf8', timeout: opts?.timeoutMs, killSignal: 'SIGKILL' })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const deps = (exec: ExecFn = isolatedExec) => ({ home, env, exec, fetch, sleep: async () => {}, hostname: () => 'migration-device', platform: process.platform, cliEntry: CLI, print: () => {} })

it('migrates an older home through actual installed CLI and MCP code, retaining backups and delaying project cleanup until a hook', async () => {
  const repo = join(root, 'project'); mkdirSync(repo)
  expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0)
  // Project cleanup runs only after this folder has opted into memory.
  writeFileSync(join(store, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: repo, plur: 'on' }] }))
  const legacy = `remote_url: ${contract.url}\nremote_token: ${contract.state.oldKey}\n`
  writeFileSync(join(repo, '.plur.yaml'), legacy)
  const result = await runEnterpriseInit(options(), deps())
  expect(result.ok, JSON.stringify({ result, requests: contract.state.requests, writes: contract.state.writes.length })).toBe(true)
  const entries = config().stores.filter((entry: any) => entry.url === contract.url)
  expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ token: contract.state.key, enterprise: { mode: 'full' }, scopes: ['user:example:member', 'group:example/team'] })
  expect(readFileSync(join(store, 'config.yaml'), 'utf8')).not.toContain(contract.state.oldKey)
  expect(readFileSync(join(result.backupDir!, 'config.yaml'), 'utf8')).toContain(contract.state.oldKey)
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers).not.toHaveProperty('plur-enterprise')
  expect(existsSync(join(store, 'mcp-enterprise-header'))).toBe(false)
  expect(readFileSync(join(repo, '.plur.yaml'), 'utf8')).toBe(legacy)
  expect(contract.state.writes.some(row => row.domain === 'plur.connect')).toBe(true)
  expect(contract.state.recalls.length).toBeGreaterThan(0)
  const child = spawn(process.execPath, [CLI, 'hook-codex-session-start'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', b => { stderr += b }); child.stdout.resume()
  child.stdin.end(JSON.stringify({ cwd: repo, session_id: 'migration-session' }))
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  expect(code, stderr).toBe(0); expect(existsSync(join(repo, '.plur.yaml'))).toBe(false)
  expect(contract.state.unknown).toEqual([])
}, 60_000)

it('repairs a partial prior installation whose old JWT still precedes its verified server entry', async () => {
  const raw = config()
  raw.stores.push({ url: contract.url, token: contract.state.key, scope: 'user:example:member', scopes: ['user:example:member', 'group:example/team'], enterprise: { mode: 'full' } })
  writeFileSync(join(store, 'config.yaml'), yaml.dump(raw))
  const result = await runEnterpriseInit(options(), deps())
  expect(result.ok, JSON.stringify({ result, requests: contract.state.requests })).toBe(true)
  expect(result.signIn.reused).toBe(true)
  expect(contract.state.deviceRequests).toBe(0)
  expect(config().stores).toHaveLength(1)
  expect(readFileSync(join(store, 'config.yaml'), 'utf8')).not.toContain(contract.state.oldKey)
  expect(readFileSync(join(result.backupDir!, 'config.yaml'), 'utf8')).toContain(contract.state.oldKey)
  expect(contract.state.writes.length).toBeGreaterThan(0)
}, 60_000)

it.each([false, true])('flushes an older queued write with its original key, including partial installation=%s', async partial => {
  writeFileSync(join(store, 'config.yaml'), 'index: false\nembeddings:\n  enabled: false\n')
  let p = new Plur({ path: store, autoDiscover: false })
  const row = await p.learn('An older queued preference', { scope: 'user:example:member' }); p.close()
  writeFileSync(join(store, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ url: contract.url, token: contract.state.oldKey, scope: 'user:example:member' }] }))
  p = new Plur({ path: store, autoDiscover: false }); contract.state.queueOnly = true
  expect((await p.uploadLocal([row.id])).results[0].outcome).toBe('queued'); p.close()
  const document = yaml.load(readFileSync(join(store, 'engrams.yaml'), 'utf8')) as any
  const rows = Array.isArray(document) ? document : document.engrams
  const key = rows.find((candidate: any) => candidate.id === row.id).structured_data._outbox.idempotency_key
  contract.state.queueOnly = false
  if (partial) {
    const raw = config()
    raw.stores.push({ url: contract.url, token: contract.state.key, scope: 'user:example:member', scopes: ['user:example:member'], enterprise: { mode: 'full' } })
    writeFileSync(join(store, 'config.yaml'), yaml.dump(raw))
  }
  const result = await runEnterpriseInit(options(), deps())
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(contract.state.writes.filter(candidate => candidate.statement === row.statement)).toHaveLength(1)
  expect(contract.state.writes.find(candidate => candidate.statement === row.statement)?.idempotency_key).toBe(key)
  expect(result.flushed?.flushed).toBe(1)
}, 60_000)

it('does not clean an older MCP launch even when the installer CLI is current', async () => {
  const old = join(root, 'older/packages/mcp/dist/index.js'); mkdirSync(join(root, 'older/packages/mcp/dist'), { recursive: true })
  writeFileSync(old, 'console.log("0.19.4")\n')
  const exec: ExecFn = (command, args, opts) => {
    const result = isolatedExec(command, args, opts)
    if (args.includes('init') && result.status === 0) {
      writeFileSync(join(env.CODEX_HOME!, 'config.toml'), `[mcp_servers.plur]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(old)}]\n[mcp_servers.plur-enterprise]\ncommand = "mcp-remote"\nargs = ["https://legacy.example.invalid/mcp"]\n`)
    }
    return result
  }
  const result = await runEnterpriseInit({ ...options(), expectVersion: CLI_VERSION }, deps(exec))
  expect(result.ok).toBe(false); expect(result.tools.find(tool => tool.tool === 'codex')?.version).toMatchObject({ ok: false, reported: '0.19.4' })
  expect(formatSummary(result).join('\n')).toContain('0.19.4')
  expect(readFileSync(join(env.CODEX_HOME!, 'config.toml'), 'utf8')).toContain('[mcp_servers.plur-enterprise]')
}, 60_000)
