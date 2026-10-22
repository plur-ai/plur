import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur, formatSaveDestination, type SaveDestinationInput } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const scope = 'project:acme/team/backend'
it.each<[SaveDestinationInput, string]>([
  [{ delivery: 'remote', scope, shared: true }, `saved to ${scope} (server)`],
  [{ delivery: 'outbox', scope, shared: true, queuedReason: 'the server is unreachable' }, `queued for ${scope} — not on the server yet: the server is unreachable`],
  [{ delivery: 'local', scope: 'local', shared: false, folder: { kind: 'local', reason: 'no-remote' } }, 'saved on this laptop only — this repo has no origin remote'],
  [{ delivery: 'local', scope: 'local', shared: false, folder: { kind: 'local', reason: 'no-scope-for-project' } }, 'saved on this laptop only — this repo has no team scope'],
  [{ delivery: 'local', scope: 'local', shared: false, folder: { kind: 'local', reason: 'not-company-gitlab' } }, 'saved on this laptop only — this repo is not on the company GitLab'],
  ...([
    ['git-unreadable', 'git could not be read'],
    ['scopes-unavailable', "the server's scope list is unavailable"],
    ['cache-stale', 'the scope list is out of date'],
    ['ambiguous-mapping', 'two scopes claim this project'],
  ] as const).map(([reason, words]): [SaveDestinationInput, string] => [
    { delivery: 'local', scope: 'local', shared: false, folder: { kind: 'unknown', reason } },
    `saved on this laptop only — could not tell this repo's team scope (${words})`,
  ]),
  [{ delivery: 'local', scope, shared: true, unauthorizedOn: 'plur.example.com' }, `saved on this laptop only — ${scope} is not granted to you on plur.example.com`],
  [{ delivery: 'local', scope, shared: true }, `saved on this laptop only — no server store for ${scope}`],
  [{ delivery: 'local', scope: 'global', shared: false }, 'saved on this laptop only'],
])('says the actual save destination %#', (input, expected) => {
  expect(formatSaveDestination(input)).toBe(expected)
})

let root: string, stub: StubServer, plur: Plur
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-save-destination-'))
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false },
    stores: [{ url, token, scope, shared: true }] }))
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => { plur.close(); await stub.stop(); rmSync(root, { recursive: true, force: true }) })
it('reports delivery from the returned write object, and a failed push as queued', async () => {
  const remote = await plur.learnRouted('Canary release protects the deployment fleet', { scope })
  expect(stub.appendCalls).toBe(1)
  expect(plur.deliveryOf(remote).destination).toBe(`saved to ${scope} (server)`)
  stub.appendErrorResponse = { status: 503, body: 'temporarily unavailable' }
  const queued = await plur.learnRouted('Database snapshots run before schema upgrades', { scope })
  const result = plur.deliveryOf(queued)
  expect(result.delivery).toBe('outbox')
  expect(result.destination).toContain(`queued for ${scope} — not on the server yet:`)
})
it('reports the admitted local folder reason, while explicit team saves report remote', async () => {
  const git = { kind: 'local', reason: 'no-remote' } as const
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false, git })
  const local = await plur.learnRouted('A scratch repository keeps its own notes')
  expect(plur.deliveryOf(local, undefined, git).destination).toBe('saved on this laptop only — this repo has no origin remote')
  const remote = await plur.learnRouted('Explicitly share the release schedule', { scope })
  expect(plur.deliveryOf(remote, scope, git).destination).toBe(`saved to ${scope} (server)`)
})
it('a sensitive-content holdback explains the actual reason instead of the repo default', async () => {
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false,
    git: { kind: 'local', reason: 'no-remote' } })
  const row = await plur.learnRouted('The service uses host db.internal for operations', { scope })
  expect(row.scope).toBe('local')
  expect(plur.deliveryOf(row, scope).destination).toBe(`saved on this laptop only — sensitive content was kept private instead of being sent to ${scope}`)
})
it('an explicit personal save does not blame the repository mapping', async () => {
  plur.bindFolderPolicy(root, { mode: 'on', source: 'git', remoteAllowed: false,
    git: { kind: 'local', reason: 'no-remote' } })
  const row = await plur.learnRouted('My editor uses a dark color theme', { scope: 'local' })
  expect(plur.deliveryOf(row, 'local').destination).toBe('saved on this laptop only')
})
