import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
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
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-session-server-')))
  mkdirSync(join(home, '.plur'))
  mapped = join(home, 'mapped'); local = join(home, 'local')
  for (const [dir, path] of [[mapped, 'team/backend'], [local, 'team/other']]) {
    mkdirSync(dir); execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://gitlab.example.com/${path}.git`])
  }
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  stub.meStatus = 200
  stub.meBody = { username: 'fixture-user', scopes: [scope], scopes_status: 'ok', org_id: 'acme',
    key_expires_at: null, gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } }
  writeFileSync(join(home, '.plur', 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false },
    stores: [{ url, token, scope, scopes: [scope], enterprise: {}, discovery: {
      status: 'ok', username: 'fixture-user', key_expires_at: null, discovered_at: new Date().toISOString(),
      gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } } }] }))
})
afterEach(async () => { await client?.close(); client = undefined; await stub.stop(); rmSync(home, { recursive: true, force: true }) })
async function start(cwd: string, roots: string[], args: Record<string, unknown> = {}, failRefresh = false) {
  client = new Client({ name: 'server-line-fixture', version: '1' }, { capabilities: { roots: { listChanged: !failRefresh } } })
  let requests = 0
  client.setRequestHandler('roots/list', async () => {
    if (failRefresh && ++requests > 1) throw new Error('fixture roots unavailable')
    return { roots: roots.map(dir => ({ uri: pathToFileURL(dir).href })) }
  })
  const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    CODEX_HOME: join(home, '.codex'), PLUR_PATH: join(home, '.plur'), PLUR_TOOL_PROFILE: 'full' }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(__dirname, '../dist/index.js')], cwd, env, stderr: 'ignore' }))
  const result = await client.callTool({ name: 'plur_session_start', arguments: { task: 'Plan the deployment', ...args } })
  const block = result.content[0]
  if (block.type !== 'text') throw new Error('Expected tool text')
  return JSON.parse(block.text)
}
it('reports the editor root destination in both server_status and guide', async () => {
  const result = await start(local, [mapped])
  expect(result.server_status).toEqual([`PLUR → server as fixture-user · saving to ${scope}`])
  expect(result.guide).toContain(result.server_status[0])
})
it('does not report the mapped process cwd as the local workspace destination', async () => {
  const result = await start(mapped, [local])
  expect(result.server_status).toHaveLength(1)
  expect(result.server_status[0]).toContain('saving on this laptop only — this repo has no team scope')
  expect(result.server_status[0]).not.toContain(`saving to ${scope}`)
})
it('an ambiguous workspace never advertises the first root as its destination', async () => {
  const result = await start(home, [mapped, local])
  expect(result.server_status).toHaveLength(1)
  expect(result.server_status[0]).toContain('saving on this laptop only')
  expect(result.server_status[0]).not.toContain(`saving to ${scope}`)
})
it('an explicit session default is reflected in the status', async () => {
  const result = await start(mapped, [local], { default_scope: scope })
  expect(result.default_scope).toBe(scope)
  expect(result.server_status).toEqual([`PLUR → server as fixture-user · saving to ${scope}`])
})
it('returns an empty status array when no enterprise server is configured', async () => {
  writeFileSync(join(home, '.plur', 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false } }))
  writeFileSync(join(home, '.plur', 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(local)}\n    plur: on\n`)
  const result = await start(local, [local])
  expect(result.server_status).toEqual([])
  expect(result.guide).not.toContain('PLUR → server')
})
it('a failed workspace refresh does not advertise the previously admitted destination', async () => {
  const result = await start(home, [mapped], {}, true)
  expect(JSON.stringify(result)).not.toContain(`saving to ${scope}`)
})
it('different explicit folder scopes never advertise the first root as a shared default', async () => {
  writeFileSync(join(home, '.plur', 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(mapped)}\n    plur: on\n    scope: ${scope}\n  - path: ${JSON.stringify(local)}\n    plur: on\n    scope: project:acme/team/other\n`)
  const result = await start(home, [mapped, local])
  expect(result.default_scope).toBeUndefined()
  expect(result.server_status).toHaveLength(1)
  expect(result.server_status[0]).not.toContain(`saving to ${scope}`)
})
