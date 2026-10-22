import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0 })

it('successfully recalls locally for an unmatched editor root while the explicit always-dial control reaches the server', async () => {
  const home = mkdtempSync(join(tmpdir(), 'plur-mcp-git-local-control-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const store = join(home, 'store'), repo = join(home, 'repo')
  mkdirSync(store); mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://git.example.test/team/unmapped.git'])
  const server = new StubServer('fixture-token')
  const { url, token } = await server.start()
  cleanups.push(() => server.stop())
  const scope = 'project:example/team/backend'
  server.meBody = {
    username: 'fixture-user', org_id: 'example', scopes: [scope], scopes_status: 'ok',
    gitlab_host: 'git.example.test', project_paths: { [scope]: 'team/backend' },
  }
  server.meStatus = 200
  writeFileSync(join(store, 'config.yaml'), JSON.stringify({
    index: false, embeddings: { enabled: false },
    stores: [{ url, token, scope, scopes: [scope], enterprise: {},
      scope_settings: { [scope]: { dial: 'always' } },
      discovery: { status: 'ok', discovered_at: new Date().toISOString(),
        gitlab_host: 'git.example.test', project_paths: { [scope]: 'team/backend' } } }],
  }))
  const client = new Client({ name: 'git-local-control', version: '1' }, { capabilities: { roots: { listChanged: true } } })
  client.setRequestHandler('roots/list', async () => ({ roots: [{ uri: pathToFileURL(repo).href }] }))
  cleanups.push(() => client.close())
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(__dirname, '../dist/index.js')], cwd: home,
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, PLUR_PATH: store,
      CODEX_HOME: join(home, 'codex'), XDG_CONFIG_HOME: join(home, 'config'), PLUR_TOOL_PROFILE: 'full' },
    stderr: 'ignore',
  }))
  for (const explicit of [false, true]) {
    const result = await client.callTool({ name: 'plur_recall',
      arguments: { query: 'canary releases', mode: 'keyword', ...(explicit ? { scope: 'global' } : {}) } })
    expect(result.isError).not.toBe(true)
    const block = result.content[0]
    expect(block.type).toBe('text')
    if (block.type !== 'text') throw Error('Expected recall text')
    expect(JSON.parse(block.text).results).toBeInstanceOf(Array)
    expect(server.recallCalls).toBe(explicit ? 1 : 0)
  }
})
