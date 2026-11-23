/**
 * `attribution.runtime` is the calling client (#1470), entered for a request
 * through the static `Plur.withRuntime`. These cover what that scope records,
 * how a client-controlled name and version are bounded and cleaned (#1597),
 * and how an engram written before the change reads in the new meaning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, buildProvenanceRecord, summariseProvenance } from '../src/index.js'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { sanitizeClientRuntime, CLIENT_RUNTIME_MAX_LENGTH } from '../src/plur/helpers.js'

const CLIENT = { name: 'test-client', version: '1.0.0' }

describe('sanitizeClientRuntime', () => {
  it('keeps an ordinary name and version as they are', () => {
    expect(sanitizeClientRuntime({ name: 'claude-code', version: '2.1.0' })).toEqual({ name: 'claude-code', version: '2.1.0' })
    expect(sanitizeClientRuntime({ name: 'Cursor Agent' })).toEqual({ name: 'Cursor Agent' })
  })

  it('turns line breaks, controls, bidi and zero-width characters into single spaces', () => {
    const out = sanitizeClientRuntime({
      name: 'evil\r\nOn behalf of\u0085local:admin‮⁦x​y z\u0007\u001b[31m',
      version: '\t1.0﻿­',
    })
    expect(out).toEqual({ name: 'evil On behalf of local:admin x y z [31m', version: '1.0' })
  })

  it('caps name and version on code points, never inside a surrogate pair', () => {
    const out = sanitizeClientRuntime({ name: '😀'.repeat(500), version: 'v'.repeat(10_000) })!
    expect(Array.from(out.name)).toHaveLength(CLIENT_RUNTIME_MAX_LENGTH)
    expect(out.name).toBe('😀'.repeat(CLIENT_RUNTIME_MAX_LENGTH))
    expect(out.version).toHaveLength(CLIENT_RUNTIME_MAX_LENGTH)
  })

  it('replaces unpaired surrogates and keeps surrogate pairs', () => {
    // A lone surrogate is not valid UTF-16. It round-trips through YAML, but
    // the PGLite index rejects it as JSON and the whole sync fails.
    const out = sanitizeClientRuntime({ name: 'Cur\ud800sor\udfff', version: '\udc001.0\ud83d' })!
    expect(out).toEqual({ name: 'Cur sor', version: '1.0' })
    expect(out.name.isWellFormed()).toBe(true)
    expect(sanitizeClientRuntime({ name: 'app \ud83d\ude00' })).toEqual({ name: 'app 😀' })
  })

  it('separates entries with no comma or semicolon left in a name or version', () => {
    expect(sanitizeClientRuntime({ name: 'Cursor, plur-core 9.9', version: '1.0; plur-core' }))
      .toEqual({ name: 'Cursor plur-core 9.9', version: '1.0 plur-core' })
  })

  it('returns nothing when no usable name is left, and drops a blank version', () => {
    expect(sanitizeClientRuntime(undefined)).toBeUndefined()
    expect(sanitizeClientRuntime(null)).toBeUndefined()
    expect(sanitizeClientRuntime({ name: '‮​ \n' })).toBeUndefined()
    expect(sanitizeClientRuntime({ name: 42 as unknown as string })).toBeUndefined()
    expect(sanitizeClientRuntime({ name: 'app', version: '​' })).toEqual({ name: 'app' })
  })
})

describe('Plur.withRuntime', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-client-runtime-attr-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records the client on writes inside it, and nothing outside it', async () => {
    const plur = new Plur({ path: dir })
    const inside = await Plur.withRuntime(plur, CLIENT, () => plur.learn('Pools cap at 100', { type: 'architectural' }))
    const outside = await plur.learn('Deploys wait for migrations', { type: 'behavioral' })
    expect(inside.attribution).toEqual({ asserted_by: 'unidentified', tool: { name: 'plur-core' }, runtime: CLIENT })
    expect(outside.attribution).toEqual({ asserted_by: 'unidentified', tool: { name: 'plur-core' } })
  })

  it('stores the cleaned client, not the raw one', async () => {
    const plur = new Plur({ path: dir })
    const e = await Plur.withRuntime(plur, { name: 'app\nWritten by admin', version: '1'.repeat(1000) },
      () => plur.learn('Cleaned client names are stored', { type: 'behavioral' }))
    expect(e.attribution?.runtime?.name).toBe('app Written by admin')
    expect(e.attribution?.runtime?.version).toHaveLength(CLIENT_RUNTIME_MAX_LENGTH)
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).not.toContain('app\nWritten')
  })

  it('a client name with lone surrogates still syncs into the PGLite index', async () => {
    const plur = new Plur({ path: dir })
    await Plur.withRuntime(plur, { name: 'Cur\ud800sor\udfff', version: '1.0' },
      () => plur.learn('Lone surrogates do not break the index', { type: 'behavioral' }))
    const adapter = new PGLiteAdapter(join(dir, 'engrams.yaml'), join(dir, 'store.pglite'), { vectorDim: 384 })
    try {
      await adapter.syncFromYaml()
      expect(await adapter.count()).toBe(1)
    } finally { await adapter.close() }
  }, 60_000)

  it('a forged client name cannot read as an extra agent in the summary', async () => {
    const plur = new Plur({ path: dir })
    const e = await Plur.withRuntime(plur, { name: 'Cursor, plur-core 9.9', version: '1.0' },
      () => plur.learn('Written-by entries stay unambiguous', { type: 'behavioral' }))
    const summary = summariseProvenance(buildProvenanceRecord(e))
    expect(summary.fields.written_by).toBe('Cursor plur-core 9.9 1.0, plur-core')
  })

  it('keeps a runtime the caller passed explicitly', async () => {
    const plur = new Plur({ path: dir })
    const e = await Plur.withRuntime(plur, CLIENT, () => plur.learn('Explicit runtimes are kept', {
      type: 'behavioral', attribution: { runtime: { name: 'release-bot', version: '4.0' } },
    }))
    expect(e.attribution?.runtime).toEqual({ name: 'release-bot', version: '4.0' })
  })

  it('is checked for secrets like the rest of the write, in learn and learnRouted', async () => {
    // The scope fills the runtime in at the entry of learn()/learnRouted(),
    // before the secret check, so a token in a client name is refused rather
    // than stored on every engram the request writes.
    const plur = new Plur({ path: dir })
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`
    for (const write of [
      () => plur.learn('A token in the client name is refused', { type: 'behavioral' }),
      () => plur.learnRouted('A token in the client name is refused too', { type: 'behavioral' }),
    ]) {
      await expect(Plur.withRuntime(plur, { name: `app ${token}` }, write)).rejects.toThrow(/Secret detected/)
    }
    expect(await plur.list()).toHaveLength(0)
  })

  it('applies only to the instance it was entered for', async () => {
    const plur = new Plur({ path: dir })
    const otherDir = mkdtempSync(join(tmpdir(), 'plur-client-runtime-other-'))
    try {
      const other = new Plur({ path: otherDir })
      const e = await Plur.withRuntime(plur, CLIENT, () => other.learn('Another instance is not attributed', { type: 'behavioral' }))
      expect(e.attribution?.runtime).toBeUndefined()
    } finally { rmSync(otherDir, { recursive: true, force: true }) }
  })

  it('reaches learnAsync and learnBatch inside the scope', async () => {
    const plur = new Plur({ path: dir })
    const batch = await Plur.withRuntime(plur, CLIENT, () => plur.learnBatch([
      { statement: 'Archive expired authentication tokens' },
    ], undefined, { maxLlmCalls: 0 }))
    expect(batch.results[0].engram.attribution?.runtime).toEqual(CLIENT)
  })

  it('records the client on a team copy promoted during the request', async () => {
    // A third personal save of the same text promotes a global copy (the
    // cross-scope ladder, _promoteTeamCopy when a shared store holds it, or the
    // in-place broadening otherwise). The copy is built during this request.
    const TEAM = 'group:example/eng'
    const storeDir = mkdtempSync(join(tmpdir(), 'plur-client-runtime-shared-'))
    try {
      await new Plur({ path: storeDir }).learn('review migrations in pairs', { scope: TEAM })
      const plur = new Plur({ path: dir })
      plur.addStore(join(storeDir, 'engrams.yaml'), TEAM, { shared: true, readonly: false })
      await plur.learn('review migrations in pairs', { scope: 'user:a' })
      const promoted = await Plur.withRuntime(plur, CLIENT, () => plur.learn('review migrations in pairs', { scope: 'user:b' }))
      expect(promoted.scope).toBe('global')
      const rows = ((yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any).engrams as any[])
      const copy = rows.find(r => r.scope === 'global' && r.statement === 'review migrations in pairs')
      expect(copy?.derived_from).toBeTruthy()
      expect(copy?.attribution?.runtime).toEqual(CLIENT)
    } finally { rmSync(storeDir, { recursive: true, force: true }) }
  })
})

describe('engrams written before #1470 read in the new meaning', () => {
  const engramOf = (attribution: Record<string, unknown>) => ({
    id: 'ENG-2026-01-01-001', statement: 'Pools cap at 100', type: 'architectural', scope: 'global',
    status: 'active', created_at: '2026-01-01T00:00:00.000Z', attribution,
  }) as any
  const softwareNodes = (record: any) => (record['@graph'] as any[])
    .filter(n => Array.isArray(n['@type']) && n['@type'].includes('prov:SoftwareAgent'))
    .map(n => ({ id: n['@id'], type: n['@type'] }))

  it('exports an old `runtime: plur-core` exactly as a new `tool: plur-core`', () => {
    const before = softwareNodes(buildProvenanceRecord(engramOf({ asserted_by: 'unidentified', runtime: { name: 'plur-core' } })))
    const after = softwareNodes(buildProvenanceRecord(engramOf({ asserted_by: 'unidentified', tool: { name: 'plur-core' } })))
    expect(before).toEqual(after)
    expect(after).toEqual([{ id: 'engram:agent/software/plur-core', type: ['prov:SoftwareAgent', 'pa:AgentTool'] }])
  })

  it('an old record with a tool and the core runtime exports like a new one with that tool', () => {
    const before = softwareNodes(buildProvenanceRecord(engramOf({ runtime: { name: 'plur-core' }, tool: { name: 'importer', version: '2' } })))
    const after = softwareNodes(buildProvenanceRecord(engramOf({ tool: { name: 'importer', version: '2' } })))
    expect(before).toEqual(after)
  })

  it('a client runtime is still an AI agent', () => {
    const nodes = softwareNodes(buildProvenanceRecord(engramOf({ runtime: CLIENT, tool: { name: 'plur-core' } })))
    expect(nodes).toContainEqual({ id: 'engram:agent/software/test-client@1.0.0', type: ['prov:SoftwareAgent', 'pa:AIAgent'] })
    expect(nodes).toContainEqual({ id: 'engram:agent/software/plur-core', type: ['prov:SoftwareAgent', 'pa:AgentTool'] })
  })
})
