/**
 * The scope hint on plur_learn says what really happened (finding L9 of the
 * third 0.21.1 pre-release check).
 *
 * The hint ("Stored at X because no scope was passed, but a team store is
 * configured … re-learn it with an explicit scope so it reaches the shared
 * store") is right only when the engram stayed on this machine. A save whose
 * scope is a team store's scope — a personal `user:` scope backed by a remote
 * store, reached through a folder or session default — already went to that
 * store (delivery "remote") or is queued for it (delivery "outbox"). The hint
 * told the agent the opposite, and an agent that followed it saved a
 * duplicate. It now appears only when the engram landed in a scope no team
 * store holds while team stores are configured.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'scope-hint-team-token'
const PERSONAL = 'user:test:tester'
const TEAM = 'group:test/eng'

let stub: StubServer
let baseUrl: string

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  baseUrl = (await stub.start()).url
})
afterAll(async () => { await stub.stop() })

describe('plur_learn scope_hint only when the engram stayed on this machine (L9)', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions('full')
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  beforeEach(() => {
    stub.reset()
    stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [PERSONAL, TEAM] })
    dir = mkdtempSync(join(tmpdir(), 'plur-scope-hint-'))
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${PERSONAL}"\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n`)
    plur = new Plur({ path: dir })
    _resetSessionTelemetry()
  })
  afterEach(() => {
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('an unscoped save that reached the team store (delivery remote) carries no hint', async () => {
    await call('plur_session_start', { task: 'hint', default_scope: PERSONAL })
    const r = await call('plur_learn', { statement: 'hint-remote the deploy target is the blue cluster' })
    expect(r.scope, JSON.stringify(r)).toBe(PERSONAL)
    expect(r.delivery).toBe('remote')
    expect(r.scope_hint, JSON.stringify(r)).toBeUndefined()
  }, 30_000)

  it('an unscoped save queued for the team store (delivery outbox) carries no hint', async () => {
    stub.appendErrorResponse = { status: 503, body: 'down' }
    await call('plur_session_start', { task: 'hint', default_scope: PERSONAL })
    const r = await call('plur_learn', { statement: 'hint-outbox the staging cluster is green' })
    expect(r.scope, JSON.stringify(r)).toBe(PERSONAL)
    expect(r.delivery).toBe('outbox')
    expect(r.scope_hint, JSON.stringify(r)).toBeUndefined()
  }, 30_000)

  it('plur_learn_batch never carries the re-learn hint for a team save', async () => {
    await call('plur_session_start', { task: 'hint', default_scope: PERSONAL })
    const r = await call('plur_learn_batch', { engrams: [{ statement: 'hint-batch the canary runs first' }] })
    expect(JSON.stringify(r)).not.toContain('re-learn it with an explicit scope')
  }, 30_000)

  it('guard: an unscoped save that stayed on this machine (global) still carries the hint', async () => {
    const r = await call('plur_learn', { statement: 'hint-local we use trunk-based development' })
    expect(r.scope).toBe('global')
    expect(r.delivery).toBe('local')
    expect(r.scope_hint).toContain(TEAM)
  }, 30_000)
})
