import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/**
 * Owner decisions A1–A3 (2026-09-29, field-report formal verification board),
 * applied to #1268.
 *
 *  A1 "never": a save to one team scope is NEVER absorbed into an engram of a
 *     different team (shared) scope. It always writes to its own team store;
 *     the matching engram is credited (recurrence + `validated_by`).
 *  A2 "both": a team engram still QUEUED for its store that hits the ladder
 *     records the recurrence on the queued row itself (count + source, scope
 *     and outbox entry kept) AND creates/credits the linked global copy.
 *  A3 "allow", as a policy setting: `recurrence.max_commitment` caps how high
 *     the ladder (team validation included) may escalate commitment. Default
 *     `locked`; `decided` stops escalation below locked.
 */
const ENG = 'group:example/eng'
const OPS = 'group:example/ops'
const URL = 'https://store.example.test/sse'

describe('recurrence decisions A1–A3', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-decisions-')); originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  const rows = (): any[] => (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any)?.engrams ?? []

  describe('A1: a team save is never absorbed into another team scope', () => {
    it('learn(): the second team gets its own engram; the first is credited', async () => {
      const plur = new Plur({ path: dir })
      const eng = await plur.learn('canary before every deploy', { scope: ENG })
      const ops = await plur.learn('canary before every deploy', { scope: OPS })
      expect(ops.id).not.toBe(eng.id)
      expect(ops.scope).toBe(OPS)
      const credited = rows().find(e => e.id === eng.id)
      expect(credited.scope).toBe(ENG)
      expect(credited.recurrence_count).toBe(1)
      expect(credited.sources.at(-1).validated_by).toBe(OPS)
    })

    it('learnRouted(): the save reaches its OWN team store', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        index: false, stores: [{ url: URL, token: 't', scope: OPS, shared: true, readonly: false }],
      }))
      const posts: any[] = []
      globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') {
          posts.push(JSON.parse(init!.body!))
          return { ok: true, status: 201, json: async () => ({ id: 'ENG-2026-09-29-960' }), text: async () => '' } as Response
        }
        return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
      }) as any
      const plur = new Plur({ path: dir })
      const eng = await plur.learnRouted('canary before every deploy', { scope: ENG })
      const ops = await plur.learnRouted('canary before every deploy', { scope: OPS })
      expect(ops.scope).toBe(OPS)
      expect(posts).toHaveLength(1)
      expect(posts[0].scope).toBe(OPS)
      expect(rows().find(e => e.id === eng.id).recurrence_count).toBe(1)
    })
  })

  describe('A2: a queued team engram records the recurrence AND gets a global copy', () => {
    it('count and source land on the queued row, scope and outbox kept, copy created then credited', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        index: false, stores: [{ url: URL, token: 't', scope: ENG, shared: true, readonly: false }],
      }))
      globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string }) => (
        (init?.method ?? 'GET') === 'POST'
          ? { ok: false, status: 500, json: async () => ({}), text: async () => 'down' }
          : { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' }
      ) as Response) as any
      const plur = new Plur({ path: dir })
      const queued = await plur.learnRouted('rotate keys quarterly', { scope: ENG })
      await plur.learn('rotate keys quarterly', { scope: 'local' })       // recurrence 1
      await plur.learn('rotate keys quarterly', { scope: 'user:alice' })  // recurrence 2 → promotion
      const row = rows().find(e => e.id === queued.id)
      expect(row.scope).toBe(ENG)
      expect(row.structured_data?._outbox).toBeDefined()
      expect(row.recurrence_count).toBe(2)
      expect(row.sources.map((s: any) => s.scope)).toContain('user:alice')
      const copies = rows().filter(e => e.statement === 'rotate keys quarterly' && e.scope === 'global')
      expect(copies).toHaveLength(1)
      expect(copies[0].derived_from).toBe(queued.id)

      await plur.learn('rotate keys quarterly', { scope: 'agent:helper' })  // recurrence 3
      expect(rows().find(e => e.id === queued.id).recurrence_count).toBe(3)
      const again = rows().filter(e => e.statement === 'rotate keys quarterly' && e.scope === 'global')
      expect(again).toHaveLength(1)
      expect(again[0].recurrence_count).toBe(3)
    })
  })

  describe('A3: recurrence.max_commitment policy', () => {
    /** global engram driven through the personal ladder, then a team save. */
    async function drive(plur: Plur): Promise<string> {
      const mine = await plur.learn('prefer small pull requests', { scope: 'global' })
      await plur.learn('prefer small pull requests', { scope: 'local' })       // 1
      await plur.learn('prefer small pull requests', { scope: 'user:alice' })  // 2 → decided
      await plur.learn('prefer small pull requests', { scope: ENG })           // 3 → team validation
      return mine.id
    }

    it('default (no key): the ladder, team validation included, may reach locked', async () => {
      const plur = new Plur({ path: dir })
      const id = await drive(plur)
      expect(rows().find(e => e.id === id).commitment).toBe('locked')
    })

    it('max_commitment: locked behaves as the default', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, recurrence: { max_commitment: 'locked' } }))
      const plur = new Plur({ path: dir })
      const id = await drive(plur)
      expect(rows().find(e => e.id === id).commitment).toBe('locked')
    })

    it('max_commitment: decided stops escalation below locked', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, recurrence: { max_commitment: 'decided' } }))
      const plur = new Plur({ path: dir })
      const id = await drive(plur)
      await plur.learn('prefer small pull requests', { scope: 'agent:helper' })  // 4, personal
      const e = rows().find(x => x.id === id)
      expect(e.commitment).toBe('decided')
      expect(e.locked_at).toBeUndefined()
    })

    it('max_commitment: decided also caps the global copy made by copy-on-promote', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        index: false, recurrence: { max_commitment: 'decided' },
        stores: [{ url: URL, token: 't', scope: ENG, shared: true, readonly: false }],
      }))
      globalThis.fetch = vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response)) as any
      const plur = new Plur({ path: dir })
      await plur.learn('lint before commit', { scope: ENG })
      for (const s of ['local', 'user:a', 'agent:b', 'user:c', 'agent:d']) {
        await plur.learn('lint before commit', { scope: s })
      }
      const copy = rows().find(e => e.statement === 'lint before commit' && e.scope === 'global')
      expect(copy.commitment).toBe('decided')
    })
  })
})
