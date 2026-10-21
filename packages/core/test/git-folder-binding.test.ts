import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import yaml from 'js-yaml'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

let root: string, stub: StubServer, plur: Plur
const scope = 'project:acme/team/backend'
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-git-binding-'))
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false },
    stores: [{ url, token, scope, shared: true, dial: 'always' }] }))
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => { plur.close(); await stub.stop(); rmSync(root, { recursive: true, force: true }) })
it('a mapped binding supplies an unscoped write default', async () => {
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false, scope,
    git: { kind: 'scope', scope, server: 'https://plur.example.com' } })
  const row = await plur.learnRouted('Canary deployments run before broad release')
  expect(row.scope).toBe(scope)
  expect(stub.appendCalls).toBe(1)
})
it('local and unknown bindings never dial even always-dial stores', async () => {
  for (const git of [{ kind: 'local', reason: 'no-remote' }, { kind: 'unknown', reason: 'cache-stale' }] as const) {
    plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false, git })
    await plur.recallHybridWithMeta('Canary deployments')
    expect(stub.recallCalls).toBe(0)
  }
  await plur.recallHybridWithMeta('Canary deployments', { scope })
  expect(stub.recallCalls).toBe(1)
})
it('a write keeps its admitted git default while the binding changes', async () => {
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false, scope,
    git: { kind: 'scope', scope, server: 'https://plur.example.com' } })
  const pending = plur.learnRouted('Deployment batches always start with a canary')
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false,
    git: { kind: 'local', reason: 'no-remote' } })
  expect((await pending).scope).toBe(scope)
  expect(stub.appendCalls).toBe(1)
})
