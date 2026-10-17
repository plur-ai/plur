// DUR-6: Switching to another supported storage backend, or upgrading PLUR, keeps every memory's text, scope and privacy, and it can still be found.
//
// Supported backends are the tiers `backend:` in config.yaml accepts (README,
// "Storage"): yaml, sqlite, pglite and postgres. postgres needs a running
// Postgres server and evals do not reach the network, so it is NOT covered
// here (reported in the hand-back); the three embedded backends are.
//
// The switch is made the way a user makes it: edit `backend:` in config.yaml
// and open the store again with `new Plur`. The upgrade is the way a user gets
// one: a store written by an older release (no content_hash, commitment,
// memory_class or version fields; no schema_version; the write counter under
// its old name) is opened by the current engine, then the shipped upgrade
// command (`plur migrate`, run from source in a child process) is run, and the
// store is opened again on each backend. Nobody calls a migration helper here.
//
// Every memory is checked for its text, scope, visibility and pinned flag, and
// must be found by a keyword search for it on every backend.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { runSource } from '../helpers/agent-tools-hooks-cli.js'
import { tempStore, type TempStore } from '../helpers/store.js'

interface Want { id: string; statement: string; scope: string; visibility: string; pinned: boolean; query: string }

const BACKENDS = ['yaml', 'sqlite', 'pglite'] as const

async function openOn(dir: string, backend: string): Promise<Plur> {
  // Change only the backend line, as a user editing config.yaml would; the rest
  // (the recorded store version in particular) stays.
  const cfg = join(dir, 'config.yaml')
  const rest = (existsSync(cfg) ? readFileSync(cfg, 'utf8') : '').split('\n').filter(l => l.trim() !== '' && !/^backend:/.test(l))
  writeFileSync(cfg, [`backend: ${backend}`, ...rest].join('\n') + '\n')
  const p = new Plur({ path: dir, autoDiscover: false })
  await p.ready()
  return p
}

async function check(p: Plur, wants: Want[], when: string): Promise<void> {
  const listed = await p.list()
  for (const w of wants) {
    const got = listed.find(e => e.id === w.id)
    expect(got, `${when}: memory ${w.id} ("${w.statement}") is missing`).toBeTruthy()
    expect(got!.statement, `${when}: the text of ${w.id} changed`).toBe(w.statement)
    expect(got!.scope, `${when}: the scope of ${w.id} changed`).toBe(w.scope)
    expect(got!.visibility ?? 'private', `${when}: the privacy of ${w.id} changed`).toBe(w.visibility)
    expect(Boolean(got!.pinned), `${when}: the pinned flag of ${w.id} changed`).toBe(w.pinned)
    const hits = await p.recall(w.query, { limit: 10, scope: w.scope })
    expect(hits.map(e => e.id), `${when}: searching "${w.query}" (scope ${w.scope}) no longer finds ${w.id}`).toContain(w.id)
    // The meaning search is where the indexed backends answer from their own
    // index (pglite: pgvector) rather than from the YAML file.
    const hybrid = await p.recallHybridWithMeta(w.query, { limit: 10, scope: w.scope })
    expect(hybrid.engrams.map(e => e.id), `${when}: the meaning+keyword search "${w.query}" (scope ${w.scope}) no longer finds ${w.id} (mode ${hybrid.mode})`).toContain(w.id)
  }
}

describe('DUR-6 a backend switch or an upgrade keeps every memory, its scope and privacy, and it is still found', () => {
  let s: TempStore | undefined
  const opened: Plur[] = []
  afterEach(async () => {
    delete process.env.PLUR_BACKEND
    for (const p of opened.splice(0)) await (p as any).close?.()
    s?.cleanup(); s = undefined
  })

  it('switching yaml -> sqlite -> pglite -> yaml keeps a mixed store whole and searchable', async () => {
    delete process.env.PLUR_BACKEND
    s = await tempStore({ embedder: 'bag-of-words' })
    const mk = async (statement: string, scope: string, visibility: 'public' | 'private', query: string, pin = false): Promise<Want> => {
      const e = await s!.plur.learn(statement, { scope, visibility })
      if (pin) await s!.plur.setPinned(e.id, true)
      return { id: e.id, statement, scope, visibility, pinned: pin, query }
    }
    const wants = [
      await mk('Database migrations run before every deploy', 'global', 'public', 'database migrations deploy'),
      await mk('The billing app reads its secrets from the vault sidecar', 'project:billing', 'private', 'billing vault sidecar'),
      await mk('Team rule: every service exposes a health endpoint', 'group:acme/eng', 'public', 'service health endpoint'),
      await mk('My personal reminder: renew the passport in March', 'global', 'private', 'renew passport march'),
      await mk('Always answer in British English', 'global', 'public', 'british english answer', true),
      await mk('The dev database on this laptop listens on port 55432', 'local', 'private', 'dev database port laptop'),
    ]
    await check(s.plur, wants, 'before any switch (yaml)')

    for (const backend of [...BACKENDS.slice(1), 'yaml'] as const) {
      const p = await openOn(s.dir, backend); opened.push(p)
      expect(p.backendSelection().tier, `precondition: config "backend: ${backend}" selects the ${backend} backend`).toBe(backend)
      await check(p, wants, `after switching to ${backend}`)
    }
  })

  it('a store written by an older release keeps every memory through opening, the upgrade command, and every backend', async () => {
    delete process.env.PLUR_BACKEND
    s = await tempStore({ embedder: 'bag-of-words' })
    const old: Want[] = [
      { id: 'ENG-2026-0105-001', statement: 'Database migrations run before every deploy', scope: 'global', visibility: 'public', pinned: false, query: 'database migrations deploy' },
      { id: 'ENG-2026-0105-002', statement: 'The billing app reads its secrets from the vault sidecar', scope: 'project:billing', visibility: 'private', pinned: false, query: 'billing vault sidecar' },
      { id: 'ENG-2026-0106-001', statement: 'Team rule: every service exposes a health endpoint', scope: 'group:acme/eng', visibility: 'public', pinned: false, query: 'service health endpoint' },
      { id: 'ENG-2026-0107-001', statement: 'Always answer in British English', scope: 'global', visibility: 'public', pinned: true, query: 'british english answer' },
    ]
    const lines = ['engrams:']
    for (const e of old) {
      lines.push(
        `  - id: ${e.id}`, `    statement: "${e.statement}"`, '    type: behavioral', `    scope: "${e.scope}"`,
        `    visibility: ${e.visibility}`, ...(e.pinned ? ['    pinned: true'] : []), '    status: active',
        '    reference_count: 2', '    tags: []', '    activation:', '      retrieval_strength: 0.8',
        '      storage_strength: 1.0', '      frequency: 2', '      last_accessed: "2026-01-10"',
      )
    }
    writeFileSync(join(s.dir, 'engrams.yaml'), lines.join('\n') + '\n')

    const first = await openOn(s.dir, 'yaml'); opened.push(first)
    await check(first, old, 'opening the older store with the current release')

    const ran = runSource('cli', ['migrate', '--path', s.dir, '--json'], {
      env: { ...process.env, PLUR_PATH: s.dir, PLUR_EMBEDDINGS: 'off' }, cwd: s.dir, timeoutMs: 240_000,
    })
    expect(ran.status, `the upgrade command failed (exit ${ran.status}): ${ran.stderr.slice(-600)}`).toBe(0)
    expect(ran.stdout, `precondition: the upgrade command applied upgrade steps to the older store; it printed ${ran.stdout.slice(0, 400)}`).toMatch(/"applied":\s*\[\s*"/)

    for (const backend of BACKENDS) {
      const p = await openOn(s.dir, backend); opened.push(p)
      expect(p.backendSelection().tier, `precondition: config "backend: ${backend}" selects the ${backend} backend`).toBe(backend)
      await check(p, old, `after the upgrade, on ${backend}`)
    }
  })
})
