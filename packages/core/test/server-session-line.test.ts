import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { Plur, formatServerSessionLine, ENTERPRISE_SETUP_COMMAND, type ServerSessionState } from '../src/index.js'

const scope = 'project:acme/team/backend'
const base: ServerSessionState = { host: 'https://plur.example.com', username: 'fixture-user', status: 'ok',
  target: { kind: 'scope', scope, server: 'https://plur.example.com' }, keyExpiresAt: null }
const prefix = 'PLUR → server as fixture-user'
it('reports a mapped project and the stable setup command', () => {
  expect(formatServerSessionLine(base)).toBe(`${prefix} · saving to ${scope}`)
  expect(ENTERPRISE_SETUP_COMMAND).toBe('plur-enterprise init')
})
it('local repositories include sharing guidance; unknown mappings give a warning', () => {
  expect(formatServerSessionLine({ ...base, target: { kind: 'local', reason: 'no-scope-for-project' } }))
    .toBe(`${prefix} · saving on this laptop only — this repo has no team scope — to share it: plur folders set . --scope <scope>`)
  expect(formatServerSessionLine({ ...base, target: { kind: 'unknown', reason: 'cache-stale' } }))
    .toBe(`${prefix} · ⚠ could not tell where saves go (the scope list is out of date) — saving on this laptop only`)
})
it('not-synced with no retained target reports local-only saving', () => {
  expect(formatServerSessionLine({ ...base, target: null, username: undefined, status: 'not_synced' }))
    .toBe("PLUR → server · ⚠ your account is not on the server's member list yet — saving on this laptop only")
})
it('distinguishes a rejected key from an automatic retry', () => {
  const queued = { count: 3, since: '2026-10-13', needsAction: true }
  expect(formatServerSessionLine({ ...base, queued }))
    .toBe(`${prefix} · saving to ${scope} · 3 saves waiting since 2026-10-13 — key rejected; run plur-enterprise init again`)
  expect(formatServerSessionLine({ ...base, queued: { ...queued, needsAction: false } }))
    .toContain('server unreachable; they retry automatically')
})
it('expiry distinguishes unknown, absent, near and expired', () => {
  const now = Date.parse('2026-10-19T00:00:00Z')
  expect(formatServerSessionLine({ ...base, keyExpiresAt: undefined })).toContain('key expiry unknown')
  expect(formatServerSessionLine({ ...base, keyExpiresAt: null })).not.toContain('key expir')
  expect(formatServerSessionLine({ ...base, now, keyExpiresAt: '2026-10-24T00:00:00Z' })).toContain('key expires in 5 days')
  expect(formatServerSessionLine({ ...base, now, keyExpiresAt: '2026-10-01T00:00:00Z' })).toContain('key expired 2026-10-01 — run plur-enterprise init again')
  expect(formatServerSessionLine({ ...base, now, keyExpiresAt: '2026-12-01T00:00:00Z' })).not.toContain('key expir')
})

let root: string, repo: string, plur: Plur | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plur-server-line-'))
  repo = join(root, 'repo'); mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/team/backend.git'])
})
afterEach(() => { plur?.close(); plur = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
it('reads cached server and queue state without a network call', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{
    url: 'https://plur.example.com', token: 'fixture-token', scopes: [scope], scope, enterprise: {},
    discovery: { status: 'ok', username: 'fixture-user', key_expires_at: null, discovered_at: new Date().toISOString(),
      gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } },
  }] }))
  plur = new Plur({ path: root, autoDiscover: false })
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network allowed'))
  expect(await plur.serverSessionLines(repo)).toEqual([`${prefix} · saving to ${scope}`])
  expect(network).not.toHaveBeenCalled()
})
it('no enterprise entry produces no line', async () => {
  plur = new Plur({ path: root, autoDiscover: false })
  expect(await plur.serverSessionLines(repo)).toEqual([])
})
it('reports queued failures from the real primary store without probing again', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{
    url: 'https://plur.example.com', token: 'fixture-token', scopes: [scope], scope, enterprise: {},
    discovery: { status: 'ok', username: 'fixture-user', key_expires_at: null, discovered_at: new Date().toISOString(),
      gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } },
  }] }))
  plur = new Plur({ path: root, autoDiscover: false })
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
  const row = await plur.learnRouted('A canary release protects the deployment fleet', { scope })
  expect(plur.deliveryOf(row).delivery).toBe('outbox')
  network.mockClear()
  const lines = await plur.serverSessionLines(repo)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('1 save waiting since ')
  expect(lines[0]).toContain('key rejected; run plur-enterprise init again')
  expect(network).not.toHaveBeenCalled()
})
it('a read-only project store cannot claim future saves will reach the server', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{
    url: 'https://plur.example.com', token: 'fixture-token', readonly: true, scopes: [scope], scope, enterprise: {},
    discovery: { status: 'ok', key_expires_at: null, discovered_at: new Date().toISOString(),
      gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } },
  }] }))
  plur = new Plur({ path: root, autoDiscover: false })
  const lines = await plur.serverSessionLines(repo)
  expect(lines[0]).not.toContain(`saving to ${scope}`)
  expect(lines[0]).toContain('read-only')
})

function configured(status = 'ok') {
  const config = { index: false, embeddings: { enabled: false }, stores: [{
    url: 'https://plur.example.com', token: 'fixture-token', scopes: [scope], scope, enterprise: {},
    discovery: { status, username: 'fixture-user', key_expires_at: null, discovered_at: new Date().toISOString(),
      gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } },
  }] }
  writeFileSync(join(root, 'config.yaml'), JSON.stringify(config))
  plur = new Plur({ path: root, autoDiscover: false })
  return config
}
it.each(['auth_failed', 'not_synced'])('a retained route after %s never promises local-only writes', async status => {
  configured(status)
  plur!.bindFolder(repo)
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
  const lines = await plur!.serverSessionLines(repo)
  expect(network).not.toHaveBeenCalled()
  const saved = await plur!.learnRouted('Retained routing still attempts team delivery')
  expect(plur!.deliveryOf(saved).delivery).toBe('outbox')
  expect(lines[0]).not.toContain('saving on this laptop only')
  expect(lines[0]).toContain(scope)
})
it('pending saves keep their original server when two entries claim the scope', async () => {
  const config = configured()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
  const saved = await plur!.learnRouted('Retain this queued team release note', { scope })
  expect(plur!.deliveryOf(saved).delivery).toBe('outbox')
  config.stores[0].scopes = []
  config.stores.push({ ...config.stores[0], url: 'https://second.example.com', scopes: [scope] })
  writeFileSync(join(root, 'config.yaml'), JSON.stringify(config))
  const lines = await plur!.serverSessionLines(repo)
  expect(lines).toHaveLength(2)
  expect(lines.filter(line => line.includes('1 save waiting'))).toHaveLength(1)
  expect(lines[0]).toContain('1 save waiting')
})
it.each([false, true])('queued saves remain visible with a removed grant (pinned=%s)', async pinned => {
  const config = configured()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
  const saved = await plur!.learnRouted('Keep this queued delivery visible until resolved', { scope })
  expect(plur!.deliveryOf(saved).delivery).toBe('outbox')
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ ...config, stores: [{ ...config.stores[0],
    scope: 'user:acme:fixture', scopes: [], ...(pinned ? { pinned_scopes: [scope] } : {}),
  }] }))
  const lines = await plur!.serverSessionLines(repo)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('1 save waiting')
  expect(lines[0]).not.toContain(saved.statement)
  expect(lines[0]).not.toContain('fixture-token')
})
it('an external read-only change is reflected by the long-lived instance', async () => {
  configured()
  const path = join(root, 'config.yaml')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.stores[0].readonly = true
  const next = new Date(statSync(path).mtimeMs + 1000)
  writeFileSync(path, JSON.stringify(config)); utimesSync(path, next, next)
  const lines = await plur!.serverSessionLines(repo)
  expect(lines[0]).toContain('read-only')
  expect(lines[0]).not.toContain(`saving to ${scope}`)
})
