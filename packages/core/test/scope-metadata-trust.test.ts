/**
 * Scope-metadata trust hardening (scope-audit 2026-07-24).
 *
 * persistScopeMetadata() copies server-authoritative metadata from /me into
 * local config store entries (#668) — which makes the SERVER an input to the
 * write-time leak guard, because the guard consults the persisted per-scope
 * `sensitivity` policy and checks `allow` BEFORE `forbid` with `allow`
 * admitting arbitrary strings. Three findings:
 *
 *  F1 (HIGH)  — a hostile/compromised enterprise endpoint serving
 *               `sensitivity:{allow:['secrets','infra']}` used to be persisted
 *               verbatim, silently disarming the guard at next session_start.
 *               TRUST RULE now: remote sensitivity may only TIGHTEN — remote
 *               `allow` is dropped, only `forbid` persists (sanitized to
 *               SENSITIVITY_CATEGORIES); a hand-edited LOCAL `allow` remains
 *               honored.
 *  F2 (MED)   — mergeStoresForWriteback restored the raw on-disk `forbid`
 *               verbatim, discarding server `forbid` changes, while the change
 *               detector compared the raw server payload — so the two could
 *               never converge and config.yaml was rewritten on EVERY
 *               session_start (mtime churn → reload storms).
 *  F5 (LOW)   — overwriting a hand-set local covers/description with server
 *               values was silent; now one logger.warning names the scope and
 *               fields (the overwrite itself stays server-authoritative).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { logger } from '../src/logger.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'metadata-trust-test-token'
const ENG = 'group:plur/engineering'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => { await server.stop() })

beforeEach(() => {
  server.reset()
  server.setMe({
    username: 'tester', org_id: 'plur', role: 'developer',
    scopes: [ENG],
    scope_metadata: [{ scope: ENG, description: 'Engineering knowledge', covers: ['plur.engineering'] }],
  })
})

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeDir(stores: unknown[], extra: Record<string, unknown> = {}): { dir: string; plur: Plur } {
  const dir = mkdtempSync(join(tmpdir(), 'plur-meta-trust-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false, ...extra }, { lineWidth: 120, noRefs: true }))
  return { dir, plur: new Plur({ path: dir }) }
}

function readStores(dir: string): Array<Record<string, any>> {
  const raw = readFileSync(join(dir, 'config.yaml'), 'utf8')
  return ((yaml.load(raw) as Record<string, unknown>).stores ?? []) as Array<Record<string, any>>
}

/** One /me pull + persist, exactly like session_start does. */
async function syncMeta(plur: Plur): Promise<void> {
  const discoveries = await plur.discoverRemoteScopes()
  plur.persistScopeMetadata(discoveries)
}

// ---------------------------------------------------------------------------
// F1 — remote sensitivity may only tighten, never loosen
// ---------------------------------------------------------------------------

describe('F1: remote `allow` cannot disarm the leak guard', () => {
  it('drops a hostile remote allow; the guard still demotes sensitive content', async () => {
    // Hostile /me: allow both categories → under the pre-audit behavior this
    // was persisted verbatim and the guard (allow checked BEFORE forbid) was
    // fully disarmed for the scope.
    server.setMe({
      scope_metadata: [{
        scope: ENG, description: 'Engineering knowledge', covers: ['plur.engineering'],
        sensitivity: { forbid: ['secrets', 'infra'], allow: ['secrets', 'infra'] },
      }],
    })
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false },
    ])
    await syncMeta(plur)

    // The remote allow is NOT persisted (absent or empty), forbid is.
    const eng = readStores(dir).find(s => s.scope === ENG)!
    expect(eng.sensitivity?.forbid).toEqual(['secrets', 'infra'])
    expect(eng.sensitivity?.allow ?? []).toEqual([])

    // End to end: infra content targeted at the shared scope still demotes.
    const e = plur.learn('deploy target is 139.59.155.82', { scope: ENG }) as { scope: string; visibility: string }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
    await new Promise(r => setTimeout(r, 60)) // let learn's background append settle before dir cleanup
  })

  it('sanitizes remote forbid to the known category enum via the /me boundary', async () => {
    // The /me path already normalizes through ScopeSensitivitySchema (unknown
    // categories dropped, empty → safe default); persistScopeMetadata adds a
    // belt-and-braces sanitize for discoveries built by other callers. Feed a
    // hand-built discovery with junk categories straight into the persist.
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false },
    ])
    plur.persistScopeMetadata([{
      url: baseUrl, ok: true, authorized: [ENG], registered: [ENG], unregistered: [],
      metadata: [{
        scope: ENG, description: 'Eng', covers: [],
        // Cast: deliberately malformed — the sanitize under test
        sensitivity: { forbid: ['secrets', 'malware', 'pii'] as never, allow: ['secrets'] },
      }],
    }])
    const eng = readStores(dir).find(s => s.scope === ENG)!
    expect(eng.sensitivity?.forbid).toEqual(['secrets'])       // junk dropped
    expect(eng.sensitivity?.allow ?? []).toEqual([])           // allow never persisted

    // All-junk forbid → the safe default, never an empty (maximally loose) list.
    plur.persistScopeMetadata([{
      url: baseUrl, ok: true, authorized: [ENG], registered: [ENG], unregistered: [],
      metadata: [{
        scope: ENG, description: 'Eng', covers: [],
        sensitivity: { forbid: ['malware'] as never, allow: [] },
      }],
    }])
    const eng2 = readStores(dir).find(s => s.scope === ENG)!
    expect(eng2.sensitivity?.forbid).toEqual(['secrets', 'infra'])
  })

  it('preserves and honors a hand-edited LOCAL allow through a metadata sync', async () => {
    server.setMe({
      scope_metadata: [{
        scope: ENG, description: 'Engineering knowledge', covers: ['plur.engineering'],
        sensitivity: { forbid: ['secrets'] },
      }],
    })
    const { dir, plur } = makeDir([
      // Deliberate LOCAL decision: this scope legitimately holds infra topology.
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false,
        sensitivity: { forbid: ['secrets'], allow: ['infra'] } },
    ])
    await syncMeta(plur)

    const eng = readStores(dir).find(s => s.scope === ENG)!
    expect(eng.sensitivity?.allow).toEqual(['infra'])   // local allow survives the sync
    expect(eng.sensitivity?.forbid).toEqual(['secrets'])

    // …and the guard still honors it: infra content stays at the shared scope.
    const e = plur.learn('deploy target is 139.59.155.82', { scope: ENG }) as { scope: string }
    expect(e.scope).toBe(ENG)
    await new Promise(r => setTimeout(r, 60)) // let learn's background remote append settle before dir cleanup
  })
})

// ---------------------------------------------------------------------------
// F2 — the change-detector and the writeback merge converge
// ---------------------------------------------------------------------------

describe('F2: metadata persist converges (no rewrite-every-session_start loop)', () => {
  it('two consecutive syncs with identical server metadata (incl. sensitivity) → second is a no-op', async () => {
    server.setMe({
      scope_metadata: [{
        scope: ENG, description: 'Engineering knowledge', covers: ['plur.engineering'],
        // sensitivity present is the historical non-convergence trigger: the raw
        // server payload (with allow) never equalled what was persisted.
        sensitivity: { forbid: ['secrets'], allow: ['anything'] },
      }],
    })
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false },
    ])
    await syncMeta(plur)
    const after1 = { mtime: statSync(join(dir, 'config.yaml')).mtimeMs, content: readFileSync(join(dir, 'config.yaml'), 'utf8') }

    await new Promise(r => setTimeout(r, 15)) // let a rewrite, if any, land a new mtime
    await syncMeta(plur)
    const after2 = { mtime: statSync(join(dir, 'config.yaml')).mtimeMs, content: readFileSync(join(dir, 'config.yaml'), 'utf8') }

    expect(after2.mtime).toBe(after1.mtime)     // no write, no mtime bump
    expect(after2.content).toBe(after1.content) // byte-identical
  })

  it('a server forbid change is persisted once (not discarded by the writeback merge), then converges', async () => {
    server.setMe({
      scope_metadata: [{ scope: ENG, description: 'Eng', covers: ['plur.engineering'], sensitivity: { forbid: ['secrets', 'infra'] } }],
    })
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false },
    ])
    await syncMeta(plur)
    expect(readStores(dir).find(s => s.scope === ENG)!.sensitivity?.forbid).toEqual(['secrets', 'infra'])

    // Server tightens the policy shape → the change must land ON DISK (the
    // pre-audit raw-forbid restore in mergeStoresForWriteback discarded it).
    server.setMe({
      scope_metadata: [{ scope: ENG, description: 'Eng', covers: ['plur.engineering'], sensitivity: { forbid: ['secrets'] } }],
    })
    await syncMeta(plur)
    expect(readStores(dir).find(s => s.scope === ENG)!.sensitivity?.forbid).toEqual(['secrets'])

    // …and the new state converges: the next identical sync is a no-op.
    const before = { mtime: statSync(join(dir, 'config.yaml')).mtimeMs, content: readFileSync(join(dir, 'config.yaml'), 'utf8') }
    await new Promise(r => setTimeout(r, 15))
    await syncMeta(plur)
    expect(statSync(join(dir, 'config.yaml')).mtimeMs).toBe(before.mtime)
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before.content)
  })

  it('converges when the server serves NO sensitivity but the local entry has one', async () => {
    // Pre-audit: sensMatch compared server-undefined vs local-object → "changed"
    // forever, but the update spread never touched sensitivity → an infinite
    // rewrite loop that changed nothing.
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false,
        description: 'Engineering knowledge', covers: ['plur.engineering'],
        sensitivity: { forbid: ['secrets'], allow: ['infra'] } },
    ])
    const before = { mtime: statSync(join(dir, 'config.yaml')).mtimeMs, content: readFileSync(join(dir, 'config.yaml'), 'utf8') }
    await new Promise(r => setTimeout(r, 15))
    await syncMeta(plur)  // server metadata carries covers+description only
    expect(statSync(join(dir, 'config.yaml')).mtimeMs).toBe(before.mtime)
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before.content)
    // Local sensitivity untouched.
    expect(readStores(dir).find(s => s.scope === ENG)!.sensitivity?.allow).toEqual(['infra'])
  })
})

// ---------------------------------------------------------------------------
// F5 — clobbering a hand-set local covers/description is visible
// ---------------------------------------------------------------------------

describe('F5: server-authoritative overwrite of local covers/description warns', () => {
  it('emits one warning naming the scope and fields when differing non-empty local values are overwritten', async () => {
    const warn = vi.spyOn(logger, 'warning')
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false,
        description: 'My hand-written description', covers: ['my', 'own', 'topics'] },
    ])
    await syncMeta(plur)

    // Overwrite happened (by design)…
    const eng = readStores(dir).find(s => s.scope === ENG)!
    expect(eng.covers).toEqual(['plur.engineering'])
    expect(eng.description).toBe('Engineering knowledge')
    // …but visibly.
    const calls = warn.mock.calls.map(args => args.join(' '))
    const hit = calls.find(m => m.includes('[plur:scope-metadata]') && m.includes(ENG))
    expect(hit).toBeDefined()
    expect(hit).toContain('covers')
    expect(hit).toContain('description')
  })

  it('does not warn when local values were empty/absent (first sync is not a clobber)', async () => {
    const warn = vi.spyOn(logger, 'warning')
    const { plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: ENG, shared: true, readonly: false },
    ])
    await syncMeta(plur)
    const calls = warn.mock.calls.map(args => args.join(' '))
    expect(calls.find(m => m.includes('[plur:scope-metadata]'))).toBeUndefined()
  })
})
