/**
 * The 2026-09 architecture audit collapsed three duplicated mechanisms on the
 * write path into one each:
 *
 *   - learn() and learnRouted() ran separate copies of the entry checks, and
 *     the copies had diverged: only learn() refused an empty statement, so the
 *     remote route would POST an empty engram.
 *   - learn() carried an inline copy of the engram literal that
 *     _buildEngramShape builds for the remote route, so a new field had to be
 *     added twice or the two routes wrote different shapes.
 *   - updateEngram/updateEngramAsync and setPinned/setPinnedAsync were four
 *     bodies documented as equivalent, drifting on what a refusing remote does.
 *
 * These pin the consolidated behaviour so a second copy cannot quietly grow
 * back. No network: the remote driver is stubbed at the resolver seam, the
 * same way set-pinned-remote.test.ts does it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

const REMOTE_SCOPE = 'group:acme/eng'

describe('write-path consolidation', () => {
  let dir: string
  let plur: Plur
  let posted: Engram[]
  let patchImpl: (id: string, body: Record<string, unknown>) => Promise<Engram | null>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-write-path-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'),
      `stores:\n  - scope: "${REMOTE_SCOPE}"\n    url: "https://example.invalid"\n    token: "t"\n`)
    plur = new Plur({ path: dir })
    await plur.ready()
    posted = []
    patchImpl = async () => null
    ;(plur as unknown as { _getRemoteDriver: () => unknown })._getRemoteDriver = () => ({
      appendAndGetServerId: async (engram: Engram) => {
        posted.push(engram)
        return { id: 'ENG-2026-09-03-777' }
      },
      append: async (engram: Engram) => { posted.push(engram) },
      patch: async (id: string, body: Record<string, unknown>) => patchImpl(id, body),
      getById: async () => null,
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('one input gate', () => {
    it('learnRouted refuses an empty statement before dialing the remote', async () => {
      await expect(plur.learnRouted('', { scope: REMOTE_SCOPE })).rejects.toThrow(TypeError)
      await expect(plur.learnRouted('', { scope: REMOTE_SCOPE })).rejects.toThrow(/non-empty string/)
      expect(posted).toEqual([])
    })

    it('learn and learnRouted reject a bad type with the same message shape', async () => {
      const ctx = { type: 'nonsense' as never }
      await expect(plur.learn('x', ctx)).rejects.toThrow(/plur\.learn: invalid type 'nonsense'/)
      await expect(plur.learnRouted('x', { ...ctx, scope: REMOTE_SCOPE })).rejects.toThrow(/plur\.learnRouted: invalid type 'nonsense'/)
      expect(posted).toEqual([])
    })

    it('both routes store the line-terminator-collapsed statement', async () => {
      // Distinct statements: the same sentence learned into a second scope
      // is cross-scope recurrence (#176) and never reaches the remote.
      const local = await plur.learn('local first line\nlocal second line', { scope: 'global' })
      const remote = await plur.learnRouted('remote first line\nremote second line', { scope: REMOTE_SCOPE })
      expect(local.statement).not.toContain('\n')
      expect(remote.statement).not.toContain('\n')
      expect(posted).toHaveLength(1)
      expect(posted[0].statement).toBe(remote.statement)
    })
  })

  describe('one engram constructor', () => {
    it('the shape posted to a remote equals the shape written locally, except id and scope', async () => {
      const context = {
        type: 'procedural' as const,
        domain: 'plur.engineering.audit',
        tags: ['audit', 'shape'],
        rationale: 'so a new field cannot land on one route only',
        source: 'write-path-consolidation.test.ts',
        commitment: 'decided' as const,
        pinned: true,
        valid_until: '2099-01-01',
      }
      // Distinct statements (same sentence in two scopes is recurrence, #176),
      // so the statement-derived fields are stripped before comparing.
      const local = await plur.learn('the local route builds the engram', { ...context, scope: 'global' })
      await plur.learnRouted('the remote route builds the engram', { ...context, scope: REMOTE_SCOPE })
      expect(posted).toHaveLength(1)
      const remote = posted[0] as Record<string, unknown>

      const strip = (e: Record<string, unknown>) => {
        const { id: _id, scope: _scope, sources: _sources, statement: _s, content_hash: _h, summary: _sum, ...rest } = e
        // learned_at is a millisecond timestamp taken per call.
        const temporal = { ...(rest.temporal as Record<string, unknown>), learned_at: 'T' }
        return { ...rest, temporal }
      }
      // Same keys, same values — activation timestamps are day-granular and
      // both writes happen in the same test, so they match too.
      expect(Object.keys(strip(remote)).sort()).toEqual(Object.keys(strip(local as unknown as Record<string, unknown>)).sort())
      expect(strip(remote)).toEqual(strip(local as unknown as Record<string, unknown>))
      expect(remote.knowledge_type).toEqual({ memory_class: 'procedural', cognitive_level: local.knowledge_type?.cognitive_level })
      expect((remote.temporal as { valid_until?: string }).valid_until).toBe('2099-01-01')
    })
  })

  describe('one body per twin', () => {
    // storePrefix('group:acme/eng') === 'GAC': an id carrying that prefix names
    // exactly this store, so its refusal is the caller's business (same rule
    // forget() adopted in #1109). A bare id is ambiguous across stores and
    // keeps the graceful null/false contract pinned by set-pinned-remote.test.ts.
    it('a refusal for a NAMESPACED id surfaces instead of reading as not-found', async () => {
      patchImpl = async () => { throw new Error('Remote patch failed: 401 token expired') }
      const ghost = {
        id: 'ENG-GAC-2026-09-03-001', scope: REMOTE_SCOPE, statement: 'clean statement', status: 'active',
      } as unknown as Engram
      await expect(plur.updateEngram(ghost)).rejects.toThrow(/401 token expired/)
      await expect(plur.updateEngramAsync(ghost)).rejects.toThrow(/401 token expired/)
      await expect(plur.setPinned('ENG-GAC-2026-09-03-001', true)).rejects.toThrow(/401 token expired/)
    })

    it('a refusal for a BARE id keeps the graceful contract: false / null, no throw', async () => {
      patchImpl = async () => { throw new Error('Remote patch failed: 401 token expired') }
      const ghost = {
        id: 'ENG-2026-09-03-004', scope: REMOTE_SCOPE, statement: 'clean statement', status: 'active',
      } as unknown as Engram
      await expect(plur.updateEngram(ghost)).resolves.toBe(false)
      await expect(plur.updateEngramAsync(ghost)).resolves.toBeNull()
      await expect(plur.setPinned('ENG-2026-09-03-004', true)).resolves.toBeNull()
    })

    it('a 404 from every store is genuinely not-found: false / null, no throw', async () => {
      patchImpl = async () => null
      const ghost = {
        id: 'ENG-GAC-2026-09-03-003', scope: REMOTE_SCOPE, statement: 'clean statement', status: 'active',
      } as unknown as Engram
      await expect(plur.updateEngram(ghost)).resolves.toBe(false)
      await expect(plur.updateEngramAsync(ghost)).resolves.toBeNull()
      await expect(plur.setPinned('ENG-GAC-2026-09-03-003', true)).resolves.toBeNull()
    })

    it('updateEngram and updateEngramAsync agree when the remote accepts', async () => {
      const served = { id: 'ENG-2026-09-03-001', scope: REMOTE_SCOPE, statement: 'served', status: 'active' } as unknown as Engram
      patchImpl = async () => served
      const ghost = { ...served, id: 'ENG-GAE-2026-09-03-001', statement: 'clean statement' } as Engram
      await expect(plur.updateEngram(ghost)).resolves.toBe(true)
      await expect(plur.updateEngramAsync(ghost)).resolves.toEqual(served)
    })

    it('setPinnedAsync is setPinned: same refusal on a namespaced id, same null on a bare one', async () => {
      patchImpl = async () => { throw new Error('Remote patch failed: 503') }
      await expect(plur.setPinned('ENG-GAC-2026-09-03-002', true)).rejects.toThrow(/503/)
      await expect(plur.setPinnedAsync('ENG-GAC-2026-09-03-002', true)).rejects.toThrow(/503/)
      await expect(plur.setPinned('ENG-2026-09-03-002', true)).resolves.toBeNull()
      await expect(plur.setPinnedAsync('ENG-2026-09-03-002', true)).resolves.toBeNull()
    })
  })
})
