import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { getToolDefinitions } from '../src/tools.js'

let root: string, plur: Plur, stub: StubServer
const scope = 'project:acme/team/backend'
const tools = getToolDefinitions('full')
const call = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.handler(args, plur) as Promise<any>
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-mcp-destination-'))
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{ url, token, scope, shared: true }] }))
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => { plur.close(); await stub.stop(); rmSync(root, { recursive: true, force: true }) })
it('single and batch saves carry the actual remote destination', async () => {
  const single = await call('plur_learn', { statement: 'A release uses a canary deployment', scope })
  expect(single.destination).toBe(`saved to ${scope} (server)`)
  const batch = await call('plur_learn_batch', { engrams: [{ statement: 'Database upgrades begin with a snapshot', scope }] })
  expect(batch.results).toHaveLength(1)
  expect(batch.results[0].destination).toBe(`saved to ${scope} (server)`)
  expect(stub.appendCalls).toBe(2)
})
it('session-end returns a destination for every completed suggestion', async () => {
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false, scope,
    git: { kind: 'scope', scope, server: 'plur.example.com' } })
  const result = await call('plur_session_end', { summary: 'Release planning session', engram_suggestions: [
    { statement: 'Canary deployment catches regressions', type: 'behavioral' },
    { statement: 'Database snapshots protect migrations', type: 'behavioral' },
  ] })
  expect(result.engrams_created).toBe(2)
  expect(result.engram_results).toHaveLength(2)
  expect(result.engram_results.map((r: any) => r.destination)).toEqual([`saved to ${scope} (server)`, `saved to ${scope} (server)`])
  expect(stub.appendCalls).toBe(2)
})
it('queued and local suggestions never claim a server save', async () => {
  stub.appendErrorResponse = { status: 503, body: 'temporarily unavailable' }
  const queued = await call('plur_learn', { statement: 'Queued deployment note', scope })
  expect(queued.destination).toContain(`queued for ${scope} — not on the server yet:`)
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false,
    git: { kind: 'local', reason: 'no-scope-for-project' } })
  const local = await call('plur_learn', { statement: 'Scratch repository keeps private notes' })
  expect(local.destination).toBe('saved on this laptop only — this repo has no team scope')
})
it('session-end explains a sensitive holdback rather than the local repo default', async () => {
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false,
    git: { kind: 'local', reason: 'no-remote' } })
  const session = await call('plur_session_start', { task: 'Plan deployment', default_scope: scope })
  expect(session.default_scope).toBe(scope)
  const result = await call('plur_session_end', { session_id: session.session_id, summary: 'Deployment planning', engram_suggestions: [
    { statement: 'The service uses host db.internal for operations', type: 'behavioral' },
  ] })
  expect(result.engrams_created).toBe(1)
  expect(result.engram_results[0].destination).toBe(`saved on this laptop only — sensitive content was kept private instead of being sent to ${scope}`)
})
