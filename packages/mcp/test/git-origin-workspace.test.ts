import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StubServer } from '../../core/test/helpers/stub-server.js'

let home: string, mapped: string, local: string, client: Client | undefined, stub: StubServer
const scope = 'project:acme/team/backend'
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-origin-mcp-')))
  mkdirSync(join(home, '.plur'))
  mapped = join(home, 'mapped'); local = join(home, 'local')
  for (const [dir, path] of [[mapped, 'team/backend'], [local, 'team/other']]) {
    mkdirSync(dir); execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://gitlab.example.com/${path}.git`])
  }
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  stub.meStatus = 200
  stub.meBody = { username: 'alice', scopes: [scope], scopes_status: 'ok', org_id: 'acme',
    gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } }
  writeFileSync(join(home, '.plur', 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false },
    stores: [{ url, token, scope, scopes: [scope], enterprise: {},
      scope_settings: { [scope]: { dial: 'always' } },
      discovery: { status: 'ok', discovered_at: new Date().toISOString(),
        gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } } }] }))
})
afterEach(async () => { await client?.close(); client = undefined; await stub.stop(); rmSync(home, { recursive: true, force: true }) })
async function start(cwd: string, roots?: string[], listChanged = true) {
  client = new Client({ name: 'origin-fixture', version: '1' }, { capabilities: roots ? { roots: { listChanged } } : {} })
  if (roots) client.setRequestHandler('roots/list', async () => ({ roots: roots.map(dir => ({ uri: pathToFileURL(dir).href })) }))
  const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    CODEX_HOME: join(home, '.codex'), PLUR_PATH: join(home, '.plur'), PLUR_TOOL_PROFILE: 'full' }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(__dirname, '../dist/index.js')], cwd, env, stderr: 'ignore' }))
}
async function learn() {
  const result = await client!.callTool({ name: 'plur_learn', arguments: { statement: 'Canary builds validate the release process' } })
  const block = result.content[0]
  if (block.type !== 'text') throw new Error('Expected tool text')
  return JSON.parse(block.text)
}
it('an origin-mapped workspace saves to the authorized project', async () => {
  await start(mapped)
  expect((await learn()).delivery).toBe('remote')
  expect(stub.appendCalls).toBe(1)
})
it('an unmatched workspace stays local and never recalls from the always-dial store', async () => {
  await start(local)
  expect((await learn()).delivery).toBe('local')
  await client!.callTool({ name: 'plur_recall', arguments: { query: 'Canary builds' } })
  expect(stub.appendCalls).toBe(0)
  expect(stub.recallCalls).toBe(0)
})
it('a mapped process cwd cannot override a local editor root', async () => {
  await start(mapped, [local])
  expect((await learn()).delivery).toBe('local')
  expect(stub.appendCalls).toBe(0)
})
it('a non-git process cwd cannot remove the local editor root boundary', async () => {
  await start(home, [local])
  expect((await learn()).delivery).toBe('local')
  await client!.callTool({ name: 'plur_recall', arguments: { query: 'Canary builds' } })
  expect(stub.appendCalls).toBe(0)
  expect(stub.recallCalls).toBe(0)
})
it('a write follows roots refreshed immediately before admission', async () => {
  await start(mapped, [mapped], false)
  let requests = 0
  client!.setRequestHandler('roots/list', async () => ({
    roots: [{ uri: pathToFileURL(++requests === 1 ? mapped : local).href }],
  }))
  expect((await learn()).delivery).toBe('local')
  expect(stub.appendCalls).toBe(0)
})
it('an unreadable refreshed workspace cannot use the previous project default', async () => {
  await start(mapped, [mapped], false)
  let requests = 0
  client!.setRequestHandler('roots/list', async () => {
    if (++requests > 1) throw new Error('fixture roots unavailable')
    return { roots: [{ uri: pathToFileURL(mapped).href }] }
  })
  const result = await learn()
  expect(result.delivery).not.toBe('remote')
  expect(stub.appendCalls).toBe(0)
})
it('a stale mapping stays local when MCP starts outside the repo', async () => {
  const configPath = join(home, '.plur', 'config.yaml')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.stores[0].discovery.discovered_at = '2000-01-01T00:00:00.000Z'
  writeFileSync(configPath, JSON.stringify(config))
  stub.meStatus = 503 // startup refresh cannot replace the stale fixture
  await start(home, [mapped])
  await client!.callTool({ name: 'plur_recall', arguments: { query: 'Canary builds' } })
  expect(stub.recallCalls).toBe(0)
})
