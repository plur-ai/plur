/**
 * What a remote write is allowed to lose, stated explicitly.
 *
 * `appendAndGetServerId()` builds its POST body from an explicit allowlist.
 * That is the right shape — a blind `JSON.stringify(engram)` would ship local
 * counters and decay state to a shared server — but an allowlist extended by
 * hand is only correct until someone adds a schema field and forgets, and
 * nothing failed when they did.
 *
 * It has now happened twice. #768 fixed it for pinned/rationale/tags/commitment/
 * validity/supersedes. #1151 is the same defect for `measured_under`,
 * `knowledge_anchors` and `dual_coding` — lost from the moment #869 shipped the
 * first of them, and invisible because `learnRouted()` returns the local shape
 * plus the server-assigned id rather than a persisted record, so the caller is
 * shown the fields that were never sent.
 *
 * Adding three names to the allowlist fixes today and guarantees a third
 * occurrence. This file is the guard instead: every field of `EngramSchema` must
 * be classified, so adding one forces a decision rather than a silent default.
 * Modelled on `packages/migrate/test/method-list.test.ts`, which does the same
 * for async methods.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import { once } from 'events'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EngramSchema } from '../src/schemas/engram.js'
import { RemoteStore } from '../src/store/remote-store.js'
import { Plur } from '../src/index.js'

/** Sent to the server, because it is engram CONTENT that a reader needs. */
const TRANSMITTED = new Set([
  'statement', 'scope', 'domain', 'type', 'tags', 'pinned', 'rationale',
  'commitment', 'locked_reason', 'source', 'provenance',
  // #1151.
  'measured_under', 'knowledge_anchors', 'dual_coding',
  // #1172. `license` is absent on purpose: it travels inside
  // `provenance.license`, so it is covered by `provenance` above.
  'attribution', 'claim_class', 'summary', 'contraindications', 'knowledge_type', 'visibility', 'created_at',
])

/** Sent as flattened top-level keys, not as the nested object. */
const FLATTENED = new Map([
  ['temporal', 'valid_from / valid_until (#347)'],
  ['relations', 'supersedes (#240)'],
])

/**
 * Deliberately local: server-assigned, or state that describes THIS install's
 * relationship with the engram rather than the engram.
 */
const LOCAL = new Map([
  ['id', 'the server assigns its own; the local id is namespaced on read'],
  ['status', 'server owns the lifecycle — DELETE soft-retires'],
  ['version', 'local record version'],
  ['engram_version', 'local record version'],
  ['previous_version_ref', 'local version chain'],
  ['consolidated', 'output of the local consolidation pass'],
  ['content_hash', 'recomputed from content; shipping it would let a stale hash travel'],
  ['activation', 'this install\'s decay and recall state'],
  ['usage', 'local usage telemetry'],
  ['write_count', 'local counter'],
  ['injection_count', 'local counter'],
  ['derivation_count', 'local counter'],
  ['recurrence_count', 'local counter'],
  ['episode_ids', 'local episode store references'],
  ['feedback_signals', 'local feedback log; the server owns remote feedback (POST /feedback)'],
  ['associations', 'local co-access graph'],
  ['source_patterns', 'local derivation bookkeeping'],
  ['pack', 'local pack membership'],
  ['abstract', 'local abstraction bookkeeping'],
  ['derived_from', 'local derivation bookkeeping'],
  ['sources', 'local write/session history; source and provenance carry portable attribution'],
  ['locked_at', 'the server owns the time of its state transition'],
  ['updated_at', 'the destination owns its mutation timestamp'],
])

/** Unsupported content is refused before a send, never silently dropped. */
const REFUSED = new Set(['entities', 'episodic', 'exchange', 'structured_data', 'insight', 'polarity'])

describe('the remote write contract covers every schema field (#1151)', () => {
  const fields = Object.keys(EngramSchema.shape)

  it('classifies every field of EngramSchema', () => {
    const unclassified = fields.filter(f =>
      !TRANSMITTED.has(f) && !FLATTENED.has(f) && !LOCAL.has(f) && !REFUSED.has(f))

    expect(unclassified,
      'a field was added to EngramSchema without deciding whether a remote write should carry it. '
      + 'Add it to TRANSMITTED (and to appendAndGetServerId\'s body), or to LOCAL / REFUSED with a reason. '
      + 'This is the check that #768 and #1151 both needed and neither had.',
    ).toEqual([])
  })

  it('classifies each field exactly once', () => {
    const dupes = fields.filter(f =>
      [TRANSMITTED.has(f), FLATTENED.has(f), LOCAL.has(f), REFUSED.has(f)].filter(Boolean).length > 1)
    expect(dupes).toEqual([])
  })

  it('names no field that the schema does not have', () => {
    const known = new Set(fields)
    const stale = [...TRANSMITTED, ...FLATTENED.keys(), ...LOCAL.keys(), ...REFUSED]
      .filter(f => !known.has(f))
    expect(stale, 'a classified field is gone from the schema — drop it from this list').toEqual([])
  })
})

/**
 * The classification guard checks that every field was CLASSIFIED. On its own
 * that is not enough (#1158): it is set membership over a hand-written list, so
 * deleting the three field spreads from `appendAndGetServerId`'s body leaves it
 * green. The very defect it was built to prevent could recur and pass it.
 *
 * So the sets have to be checked against the REQUEST, not only against each
 * other: everything in TRANSMITTED must actually appear on the wire when it is
 * set. That is the assertion that ties the list to the code.
 */
describe('every TRANSMITTED field actually reaches the wire (#1158)', () => {
  const SCOPE = 'group:acme/eng'
  let dir: string
  let server: Server
  let posted: Record<string, unknown> | undefined
  let plur: Plur

  beforeEach(async () => {
    posted = undefined
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        posted = body
        return res.end(JSON.stringify({ id: 'ENG-2026-0907-777' }))
      }
      res.end(JSON.stringify({ rows: [], total_count: 0 }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    dir = mkdtempSync(join(tmpdir(), 'plur-wire-coverage-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      `stores:\n  - scope: "${SCOPE}"\n    url: "${url}"\n    token: "t"\n`)
    plur = new Plur({ path: dir })
    await plur.ready()
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
  })

  it('sends every field named in TRANSMITTED when all of them are set', async () => {
    // Driven through `RemoteStore.appendAndGetServerId` with a fully-populated
    // engram, NOT through `learnRouted`. The wire contract is a property of the
    // store driver; routing it through learn would test the context->engram
    // mapping at the same time and blame the wrong layer. Written the other way
    // round first, this reported `locked_reason` and `provenance` as missing —
    // both were the test's fault (`locked_reason` survives only when
    // `commitment: 'locked'`, and `provenance` is not a learn parameter at all).
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const driver = new RemoteStore(url, 't', SCOPE)

    const full = EngramSchema.parse({
      id: 'ENG-2026-0907-777',
      statement: 'Median vector lookup latency was 18 ms in the synthetic benchmark.',
      type: 'architectural', scope: SCOPE, status: 'active',
      domain: 'plur.engineering.search',
      tags: ['bench', 'latency'],
      pinned: true,
      rationale: 'The measurement is only meaningful with its conditions attached.',
      commitment: 'locked',
      locked_reason: 'benchmark baseline',
      source: 'bench/results.json',
      provenance: { origin: 'measurement' },
      measured_under: { hardware: '8-core', dataset: '100 rows', source_type: 'bench', date: '2026-09-07' },
      knowledge_anchors: [{ path: 'bench/results.json', relevance: 'primary', snippet: 'Median 18 ms.' }],
      dual_coding: { example: 'Applies to the measured dataset and machine.' },
      // #1172 — who is answerable, and what kind of claim this is.
      attribution: {
        asserted_by: 'agent:bench-runner',
        runtime: { name: 'plur-core', version: '0.19.4' },
      },
      claim_class: 'observed',
      created_at: '2026-09-08T00:00:00Z', summary: 'A measured baseline', contraindications: ['Does not apply on a different dataset'],
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'understand' }, visibility: 'public',
    })

    await driver.appendAndGetServerId(full as never)

    const sent = new Set(Object.keys(posted!))
    const missing = [...TRANSMITTED].filter(f => !sent.has(f))

    // The assertion the membership guard cannot make. Delete a field spread
    // from appendAndGetServerId and this goes red, while the classification
    // suite above stays green — which is exactly how #768 and #1151 shipped.
    expect(missing,
      'a field is classified TRANSMITTED but never reaches the request body. '
      + 'Either add it to appendAndGetServerId, or reclassify it with a reason.',
    ).toEqual([])
  })

  it('sends the flattened keys the nested fields map to', async () => {
    // `temporal` and `relations` are classified FLATTENED, meaning they travel
    // as top-level keys rather than as the nested object. Nothing checked that
    // the flattening still happened.
    await plur.learnRouted('A claim with a validity window and a supersession.', {
      scope: SCOPE,
      type: 'behavioral',
      valid_from: '2026-09-01',
      valid_until: '2026-12-31',
      supersedes: ['ENG-2026-0101-001'],
    } as never)

    expect(posted!.valid_from).toBe('2026-09-01')
    expect(posted!.valid_until).toBe('2026-12-31')
    expect(posted!.supersedes).toEqual(['ENG-2026-0101-001'])
    // The nested containers themselves must NOT ride along.
    expect(Object.keys(posted!)).not.toContain('temporal')
    expect(Object.keys(posted!)).not.toContain('relations')
  })
})

describe('measured_under and its neighbours survive a remote write (#1151)', () => {
  const SCOPE = 'group:acme/eng'
  let dir: string
  let server: Server
  let posted: Record<string, unknown> | undefined
  let stored: Record<string, unknown> | undefined
  let plur: Plur

  const CONTEXT = {
    scope: SCOPE,
    type: 'architectural' as const,
    measured_under: {
      hardware: '8-core test machine', dataset: '100 synthetic records',
      source_type: 'bench', date: '2026-09-07',
    },
    knowledge_anchors: [{ path: 'bench/results.json', relevance: 'primary', snippet: 'Median latency was 18 ms.' }],
    dual_coding: { example: 'This result applies to the measured dataset and machine.' },
  }

  beforeEach(async () => {
    posted = undefined
    stored = undefined
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        posted = body
        // Persist exactly what arrived — no server-side field filter, so any
        // loss observed below is the client's.
        stored = body
        return res.end(JSON.stringify({ id: 'ENG-2026-0907-501' }))
      }
      if (req.url?.includes('/engrams/')) {
        return res.end(JSON.stringify({ id: 'ENG-2026-0907-501', scope: SCOPE, status: 'active', data: stored }))
      }
      res.end(JSON.stringify({ rows: [], total_count: 0 }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    dir = mkdtempSync(join(tmpdir(), 'plur-write-contract-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      `stores:\n  - scope: "${SCOPE}"\n    url: "${url}"\n    token: "t"\n`)
    plur = new Plur({ path: dir })
    await plur.ready()
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
  })

  it('transmits the measurement conditions, not just the claim', async () => {
    await plur.learnRouted('Median vector lookup latency was 18 ms in the synthetic benchmark.', CONTEXT)
    // The POST carried exactly ["statement","scope","type","commitment"] before.
    expect(posted!.measured_under).toEqual(CONTEXT.measured_under)
  })

  it('transmits knowledge_anchors and dual_coding', async () => {
    await plur.learnRouted('Median vector lookup latency was 18 ms in the synthetic benchmark.', CONTEXT)
    expect(posted!.knowledge_anchors).toEqual(CONTEXT.knowledge_anchors)
    expect(posted!.dual_coding).toEqual(CONTEXT.dual_coding)
  })

  it('omits them entirely when unset, so the body stays byte-identical without them', async () => {
    await plur.learnRouted('A claim with no measurement behind it.', { scope: SCOPE, type: 'behavioral' })
    expect(Object.keys(posted!)).not.toContain('measured_under')
    expect(Object.keys(posted!)).not.toContain('knowledge_anchors')
    expect(Object.keys(posted!)).not.toContain('dual_coding')
  })
})
