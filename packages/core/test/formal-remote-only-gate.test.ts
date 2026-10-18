/**
 * The remote-only write gate against the shared resolver (WritePath §3d,
 * merge of #1521 onto development).
 *
 * `_isDeliverableTeamScope` reads `resolveScopeTarget` (#1631): a scope two
 * servers claim is refused with the resolver's own error, and a scope whose
 * only server entry is readonly is not deliverable. Nothing is written or
 * sent in either case. Model: `old_deliverable_accepts_conflict`,
 * `ro_conflict_refuses`, `ro_blocked_refuses`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, RemoteOnlyWriteError, ScopeConflictError } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TEAM = 'group:acme/client'
let base: string, root: string, work: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-gate-')))
  root = join(base, '.plur'); work = join(base, 'client')
  mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
  writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${work}"\n    plur: remote-only\n    scope: ${TEAM}\n`)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function config(stores: object[]): void {
  writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores }))
}
function rows(): string {
  const f = join(root, 'engrams.yaml')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn() } catch (err) { return err }
  return null
}

describe('remote-only write gate and the shared resolver', () => {
  it('a team scope two servers claim is refused with ScopeConflictError; nothing is written', async () => {
    config([
      { url: 'http://127.0.0.1:9/a', token: 't1', scope: TEAM, shared: true, readonly: false },
      { url: 'http://127.0.0.2:9/b', token: 't2', scope: TEAM, shared: true, readonly: false },
    ])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    expect(plur.remoteOnlyFolder()?.scope).toBe(TEAM)
    const err = await thrown(() => plur.learn('conflicted team note GATEOTTER'))
    expect(err).toBeInstanceOf(ScopeConflictError)
    expect(rows()).not.toContain('GATEOTTER')
  })

  it('a team scope served only by a readonly entry is not deliverable: refused, nothing written', async () => {
    config([{ url: 'http://127.0.0.1:9/a', token: 't1', scope: TEAM, shared: true, readonly: true }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const err = await thrown(() => plur.learn('readonly team note GATEHERON'))
    expect(err).toBeInstanceOf(RemoteOnlyWriteError)
    expect(rows()).not.toContain('GATEHERON')
  })

  it('an unreadable folder map writes and sends nothing, an explicit team scope included', async () => {
    const server = new StubServer('t1')
    const { url } = await server.start()
    try {
      config([{ url, token: 't1', scope: TEAM, shared: true, readonly: false }])
      writeFileSync(join(root, 'folders.yaml'), 'version: 1\nfolders: [[[\n')
      const plur = new Plur({ path: root })
      plur.bindFolder(work)
      expect(plur.remoteOnlyFolder()?.blocked).toBeTruthy()
      const err = await thrown(() => plur.learn('blocked team note GATEMOLE', { scope: TEAM }))
      expect(err).toBeInstanceOf(RemoteOnlyWriteError)
      expect(rows()).not.toContain('GATEMOLE')
      expect(server.appendStatements.join('\n')).not.toContain('GATEMOLE')
    } finally {
      await server.stop()
    }
  })
})
