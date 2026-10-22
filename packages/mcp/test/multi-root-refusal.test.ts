import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

let root: string, a: string, b: string, plur: Plur, client: Client, mcp: Awaited<ReturnType<typeof createServer>>
let servers: StubServer[], roots: string[]
const scopes = ['project:example/team/app', 'project:other/team/app', 'project:unrelated/team/app']
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-roots-refusal-')))
  a = join(root, 'a'); b = join(root, 'b'); mkdirSync(a); mkdirSync(b); roots = [a, b]
  servers = [new StubServer('fixture-key'), new StubServer('fixture-key'), new StubServer('fixture-key')]
  const stores = []
  for (const [i, stub] of servers.entries()) { const { url, token } = await stub.start(); stores.push({ url, token, scope: scopes[i] }); stub.setMe({ username: 'fixture', org_id: scopes[i].split(':')[1].split('/')[0], scopes: [scopes[i]] }) }
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores }))
  map(scopes[0], undefined)
  plur = new Plur({ path: root, autoDiscover: false })
  mcp = await createServer(plur, { profile: 'full', folder: a, discovery: false })
  client = new Client({ name: 'fixture', version: '1' }, { capabilities: { roots: { listChanged: true } } })
  client.setRequestHandler('roots/list' as any, async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: 'fixture' })) }))
  const [ct, st] = InMemoryTransport.createLinkedPair(); await mcp.connect(st); await client.connect(ct)
})
afterEach(async () => { await client.close(); await mcp.close(); plur.close(); for (const s of servers) await s.stop(); rmSync(root, { recursive: true, force: true }) })
function map(first?: string, second?: string) { writeFileSync(join(root, 'folders.yaml'), JSON.stringify({ version: 1, folders: [{ path: a, plur: 'on', scope: first }, { path: b, plur: 'on', scope: second }] })) }
const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as any)[0].text)
const localText = () => existsSync(join(root, 'engrams.yaml')) ? readFileSync(join(root, 'engrams.yaml'), 'utf8') : ''
it('refuses an unscoped save and names server and local choices without writing', async () => {
  const r = await call('plur_learn', { statement: 'Ambiguous release notes stay unsaved' })
  expect(r).toMatchObject({ saved: false, refused: 'roots-disagree', choices: [scopes[0], 'global'] })
  expect(r.message).toContain('Nothing was saved'); expect(r.message).toContain(a); expect(r.message).toContain(b)
  expect(servers.flatMap(s => s.appendStatements)).toEqual([])
  expect(localText()).not.toContain('Ambiguous release')
})
it('explicit local and server choices still work', async () => {
  expect(await call('plur_learn', { statement: 'Use a concise editor theme', scope: 'global' })).toMatchObject({ scope: 'global', delivery: 'local' })
  expect(await call('plur_learn', { statement: 'Run deployment checks before publishing', scope: scopes[0] })).toMatchObject({ scope: scopes[0], delivery: 'remote' })
  expect(servers[0].appendStatements).toContain('Run deployment checks before publishing')
})
it('a batch containing an unscoped item saves nothing, including its explicit item', async () => {
  const r = await call('plur_learn_batch', { engrams: [{ statement: 'Explicit batch entry must wait', scope: scopes[0] }, { statement: 'Ambiguous batch entry must wait' }] })
  expect(r).toMatchObject({ saved: false, refused: 'roots-disagree' })
  expect(servers.flatMap(s => s.appendStatements)).toEqual([])
  expect(localText()).not.toContain('batch entry')
})
it('a batch with explicit destinations succeeds', async () => {
  const r = await call('plur_learn_batch', { engrams: [{ statement: 'Explicit batch deployment rule', scope: scopes[0] }] })
  expect(r.refused).toBeUndefined()
  expect(servers[0].appendStatements).toContain('Explicit batch deployment rule')
})
it.each(['global', null, false])('an undeclared batch scope %s cannot bypass item destination choice', async scope => {
  const r = await call('plur_learn_batch', { scope, engrams: [{ statement: 'Undeclared outer scope must not save this' }] })
  expect(r).toMatchObject({ saved: false, refused: 'roots-disagree' })
  expect(servers.flatMap(s => s.appendStatements)).toEqual([])
  expect(localText()).not.toContain('Undeclared outer scope')
})
it('session end returns ambiguous suggestions unsaved but honors explicit ones', async () => {
  const r = await call('plur_session_end', { summary: 'Discussed safe deployments', engram_suggestions: [
    { statement: 'Ambiguous suggestion requires a destination' }, { statement: 'Explicit suggestion stays local', scope: 'global' },
  ] })
  expect(r.unsaved).toHaveLength(1)
  expect(r.unsaved[0]).toMatchObject({ statement: 'Ambiguous suggestion requires a destination', refused: 'roots-disagree' })
  expect(r.engrams_created).toBe(1)
  expect(localText()).not.toContain('Ambiguous suggestion requires')
})
it.each(['keyword', 'hybrid'])('unscoped %s recall consults both root organizations but no unrelated server', async mode => {
  map(scopes[0], scopes[1])
  await call('plur_recall', { query: 'release checks', mode })
  expect(servers.map(s => s.recallCalls)).toEqual([1, 1, 0])
})
it('an explicit recall scope takes precedence over the multi-root context', async () => {
  map(scopes[0], scopes[1])
  await call('plur_recall', { query: 'release checks', mode: 'keyword', scope: scopes[0] })
  expect(servers.map(s => s.recallCalls)).toEqual([1, 0, 0])
})
it.each(['keyword', 'hybrid'])('real Git roots preserve their organization context for %s recall', async mode => {
  for (const [i, folder] of [a, b].entries()) {
    execFileSync('git', ['init', '-q', folder])
    execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', `https://git${i}.example.test/team/app.git`])
  }
  const path = join(root, 'config.yaml'), config = JSON.parse(readFileSync(path, 'utf8'))
  config.stores = config.stores.map((entry: any, i: number) => i > 1 ? entry : ({ ...entry, scopes: [scopes[i]], enterprise: {},
    discovery: { status: 'ok', discovered_at: new Date().toISOString(), gitlab_host: `git${i}.example.test`, project_paths: { [scopes[i]]: 'team/app' } },
  }))
  writeFileSync(path, JSON.stringify(config)); map()
  await call('plur_recall', { query: 'release checks', mode })
  expect(servers.map(s => s.recallCalls)).toEqual([1, 1, 0])
})
it.each(['keyword', 'hybrid'])('a mapped root alongside an unmatched Git root consults only the mapped organization (%s)', async mode => {
  execFileSync('git', ['init', '-q', b])
  execFileSync('git', ['-C', b, 'remote', 'add', 'origin', 'https://unmatched.example.test/team/local.git'])
  await call('plur_recall', { query: 'release checks', mode })
  expect(servers.map(s => s.recallCalls)).toEqual([1, 0, 0])
})
it.each(['keyword', 'hybrid'])('a single unmatched Git root keeps unscoped %s recall local', async mode => {
  execFileSync('git', ['init', '-q', b])
  execFileSync('git', ['-C', b, 'remote', 'add', 'origin', 'https://unmatched.example.test/team/local.git'])
  roots = [b]
  await call('plur_recall', { query: 'release checks', mode })
  expect(servers.map(s => s.recallCalls)).toEqual([0, 0, 0])
})
