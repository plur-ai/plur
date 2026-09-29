import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/**
 * #1268 — cross-scope recurrence matched any active engram with the same
 * content hash in a DIFFERENT scope and updated it INSTEAD of writing. A
 * shared-scope save whose text matched a personal engram therefore never
 * reached the team scope. Found while triaging an enterprise deployment's
 * report of team saves that never reached the team store.
 *
 * Owner decision (2026-09-29):
 *  1. A shared-scope save always writes its team copy. It is never absorbed
 *     into a non-shared engram — `local`, `global`, `user:*`, `agent:*` —
 *     including a `global` engram the ladder itself graduated.
 *  2. The non-shared counterpart is still credited: the team save is recorded
 *     as a recurrence ON it (counted, a source marked `validated_by` the team
 *     scope, commitment escalated by the existing ladder but never to
 *     `locked`). The user may end up with two engrams, which is intended.
 *  3. The ladder never rewrites to `global` an engram that is queued for
 *     (outbox) or served by a remote team store.
 *
 * Shared↔shared and personal→personal recurrence are unchanged.
 */
const TEAM = 'group:example/eng'
const URL = 'https://store.example.test/sse'

describe('shared-scope saves and cross-scope recurrence (#1268)', () => {
  let dir: string
  let plur: Plur
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-recur-shared-'))
    plur = new Plur({ path: dir })
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const find = async (id: string) => (await plur.list()).find(e => e.id === id)!

  describe('1+2: the team copy is written AND the counterpart is credited', () => {
    for (const personal of ['global', 'local', 'user:alice', 'agent:helper']) {
      for (const shared of [TEAM, 'project:example']) {
        it(`${shared} save after a ${personal} engram`, async () => {
          const mine = await plur.learn('run migrations before deploys', { scope: personal })
          const team = await plur.learn('run migrations before deploys', { scope: shared })

          // 1: the team copy exists, in its team scope
          expect(team.id).not.toBe(mine.id)
          expect(team.scope).toBe(shared)
          const all = await plur.list()
          expect(all.filter(e => e.statement === 'run migrations before deploys').map(e => e.scope).sort())
            .toEqual([personal, shared].sort())

          // 2: the counterpart is credited, stays in its own scope
          const counterpart = await find(mine.id)
          expect(counterpart.scope).toBe(personal)
          expect(counterpart.recurrence_count).toBe(1)
          const last = counterpart.sources!.at(-1)!
          expect(last.scope).toBe(shared)
          expect((last as any).validated_by).toBe(shared)
        })
      }
    }

    it('a graduated global engram is not absorbed either — the team copy is written', async () => {
      const a = await plur.learn('tag releases', { scope: 'project:a' })
      await plur.learn('tag releases', { scope: 'project:b' })
      const graduated = await plur.learn('tag releases', { scope: 'project:c' })
      expect(graduated.scope).toBe('global')

      const team = await plur.learn('tag releases', { scope: TEAM })
      expect(team.id).not.toBe(a.id)
      expect(team.scope).toBe(TEAM)
      expect((await find(a.id)).recurrence_count).toBe(3)
    })

    it('team validation escalates commitment but never to locked', async () => {
      const mine = await plur.learn('prefer small PRs', { scope: 'global' })
      await plur.learn('prefer small PRs', { scope: 'local' })       // recurrence 1
      await plur.learn('prefer small PRs', { scope: 'user:alice' })  // recurrence 2 → decided
      expect((await find(mine.id)).commitment).toBe('decided')

      await plur.learn('prefer small PRs', { scope: TEAM })          // recurrence 3 — would lock
      const after = await find(mine.id)
      expect(after.recurrence_count).toBe(3)
      expect(after.commitment).toBe('decided')
      expect(after.locked_at).toBeUndefined()
    })

    it('learnRouted with a team store: the team copy is POSTed and the counterpart credited', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        index: false, stores: [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }],
      }))
      const posts: any[] = []
      globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') {
          posts.push(JSON.parse(init!.body!))
          return { ok: true, status: 201, json: async () => ({ id: 'ENG-2026-09-29-900' }), text: async () => '' } as Response
        }
        return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
      }) as any
      plur = new Plur({ path: dir })
      const mine = await plur.learnRouted('squash before merge', { scope: 'global' })
      const team = await plur.learnRouted('squash before merge', { scope: TEAM })
      expect(team.id).not.toBe(mine.id)
      expect(posts).toHaveLength(1)
      expect(posts[0].scope).toBe(TEAM)
      expect((await find(mine.id)).recurrence_count).toBe(1)
    })
  })

  // Owner decision (2026-09-29): what is in a team store stays there —
  // url stores AND `shared: true` file-path stores. When the ladder would
  // broaden a team-bound engram to global, it leaves the team engram untouched
  // and creates ONE global copy in the local primary store instead
  // (copy-on-promote). The copy links back via `derived_from`, carries a
  // source with `promoted_from: <team scope>`, never locks, and is never
  // queued for or pushed to a team store.
  describe('3: copy-on-promote for an engram bound for a team store', () => {
    const primaryRows = (): any[] =>
      (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any)?.engrams ?? []
    const copiesOf = (statement: string) =>
      primaryRows().filter(e => e.statement === statement && e.scope === 'global')

    function expectCopy(statement: string, teamId: string, recurrence: number) {
      const copies = copiesOf(statement)
      expect(copies).toHaveLength(1)
      const c = copies[0]
      expect(c.derived_from).toBe(teamId)
      expect(c.recurrence_count).toBe(recurrence)
      expect(c.commitment).not.toBe('locked')
      expect(c.structured_data?._outbox).toBeUndefined()
      expect((c.sources ?? []).some((x: any) => x.promoted_from === TEAM)).toBe(true)
      return c
    }

    it('a queued (outbox) team engram is left untouched; one global copy is made and never queued', async () => {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        index: false, stores: [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }],
      }))
      let postOk = false
      const posts: any[] = []
      globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') {
          if (!postOk) return { ok: false, status: 500, json: async () => ({}), text: async () => 'down' } as Response
          posts.push(JSON.parse(init!.body!))
          return { ok: true, status: 201, json: async () => ({ id: 'ENG-2026-09-29-901' }), text: async () => '' } as Response
        }
        return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
      }) as any
      plur = new Plur({ path: dir })

      const queued = await plur.learnRouted('pin node versions', { scope: TEAM })
      expect((queued as any).structured_data?._outbox).toBeDefined()
      await plur.learnRouted('pin node versions', { scope: 'project:a' })   // recurrence 1 on the team engram
      const promoted = await plur.learnRouted('pin node versions', { scope: 'project:b' })
      expect(promoted.scope).toBe('global')
      expect(promoted.id).not.toBe(queued.id)

      const team = primaryRows().find(e => e.id === queued.id)
      expect(team.scope).toBe(TEAM)
      expect(team.recurrence_count).toBe(1)                // untouched by the promotion
      expect(team.structured_data?._outbox).toBeDefined()   // still queued, as it was
      expectCopy('pin node versions', queued.id, 2)

      // Idempotent: a further recurrence credits the same copy.
      await plur.learnRouted('pin node versions', { scope: 'project:c' })
      expectCopy('pin node versions', queued.id, 3)
      expect(primaryRows().find(e => e.id === queued.id).recurrence_count).toBe(1)

      // Only the team engram is in the outbox, and it flushes with its team scope.
      expect(await plur.outboxCount()).toBe(1)
      postOk = true
      await plur.flushOutbox()
      expect(posts).toHaveLength(1)
      expect(posts[0].scope).toBe(TEAM)
    })

    it('an engram in a scope served by a url store: team engram untouched, global copy made', async () => {
      const seed = await plur.learn('lint before commit', { scope: TEAM })
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        index: false, stores: [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }],
      }))
      globalThis.fetch = vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response)) as any
      plur = new Plur({ path: dir })
      await plur.learn('lint before commit', { scope: 'project:a' })
      const promoted = await plur.learn('lint before commit', { scope: 'project:b' })
      expect(promoted.scope).toBe('global')
      expect(primaryRows().find(e => e.id === seed.id).scope).toBe(TEAM)
      expectCopy('lint before commit', seed.id, 2)
    })

    it('an engram in a shared file-path store: the file is untouched, the copy is local', async () => {
      const storeDir = mkdtempSync(join(tmpdir(), 'plur-shared-path-'))
      const storePath = join(storeDir, 'engrams.yaml')
      try {
        // Seed the engram IN the shared store file (a teammate's write).
        await new Plur({ path: storeDir }).learn('review migrations in pairs', { scope: TEAM })
        plur.addStore(storePath, TEAM, { shared: true, readonly: false })
        const first = await plur.learn('review migrations in pairs', { scope: 'project:a' })
        const teamId = first.id
        const fileBefore = readFileSync(storePath, 'utf8')
        const promoted = await plur.learn('review migrations in pairs', { scope: 'project:b' })
        expect(promoted.scope).toBe('global')
        expect(readFileSync(storePath, 'utf8')).toBe(fileBefore)   // team file untouched
        expectCopy('review migrations in pairs', teamId, 2)
        await plur.learn('review migrations in pairs', { scope: 'project:c' })
        expectCopy('review migrations in pairs', teamId, 3)
        expect(readFileSync(storePath, 'utf8')).toBe(fileBefore)
      } finally { rmSync(storeDir, { recursive: true, force: true }) }
    })

    it('an engram in a NON-shared file-path store still broadens in place (unchanged)', async () => {
      const storeDir = mkdtempSync(join(tmpdir(), 'plur-private-path-'))
      const storePath = join(storeDir, 'engrams.yaml')
      try {
        await new Plur({ path: storeDir }).learn('keep a changelog', { scope: 'project:mine' })
        plur.addStore(storePath, 'project:mine', { shared: false, readonly: false })
        const first = await plur.learn('keep a changelog', { scope: 'project:a' })
        const after = await plur.learn('keep a changelog', { scope: 'project:b' })
        expect(after.id).toBe(first.id)
        expect(after.scope).toBe('global')
      } finally { rmSync(storeDir, { recursive: true, force: true }) }
    })

    it('without a team store the ladder still broadens in place (unchanged)', async () => {
      const first = await plur.learn('write the test first', { scope: TEAM })
      await plur.learn('write the test first', { scope: 'project:a' })
      const after = await plur.learn('write the test first', { scope: 'project:b' })
      expect(after.id).toBe(first.id)
      expect(after.scope).toBe('global')
      expect(copiesOf('write the test first')).toHaveLength(1)
    })
  })

  describe('unchanged', () => {
    it('shared↔shared recurrence absorbs as before', async () => {
      const a = await plur.learn('pin versions', { scope: TEAM })
      const b = await plur.learn('pin versions', { scope: 'project:example' })
      expect(b.id).toBe(a.id)
      expect(b.recurrence_count).toBe(1)
    })

    it('personal→personal recurrence absorbs as before', async () => {
      const a = await plur.learn('prefer tabs', { scope: 'local' })
      const b = await plur.learn('prefer tabs', { scope: 'user:alice' })
      expect(b.id).toBe(a.id)
      expect(b.recurrence_count).toBe(1)
    })

    // From the review of the earlier carve-out: `rescope` leaves `sources`
    // untouched, so a user who moved a project engram to their personal global
    // scope must still get the team copy written, not absorbed.
    it('a shared-origin engram the user rescoped to global is credited, and the team copy is written', async () => {
      const mine = await plur.learn('rotate deploy keys monthly', { scope: 'project:x' })
      const moved = await plur.rescope([mine.id], 'global')
      expect(moved.results[0].status).toBe('rescoped')
      const team = await plur.learn('rotate deploy keys monthly', { scope: TEAM })
      expect(team.id).not.toBe(mine.id)
      expect(team.scope).toBe(TEAM)
      const stored = (await plur.list()).find(e => e.id === mine.id)!
      expect(stored.scope).toBe('global')
      expect(stored.recurrence_count).toBe(1)
    })

    it('a personal save recurs onto a shared engram as before', async () => {
      const a = await plur.learn('lint first', { scope: TEAM })
      const b = await plur.learn('lint first', { scope: 'global' })
      expect(b.id).toBe(a.id)
      expect(b.recurrence_count).toBe(1)
    })
  })
})
