/**
 * `remote-only` folders: a folder-map mode where memory lives only on the team
 * server. Owner decisions 2026-10-01:
 *
 *   - `plur folders set <dir> --remote-only --scope <s>` records the entry; the
 *     scope must be served by a configured url store.
 *   - In such a folder an unscoped write goes to the folder's remote scope
 *     (that scope is the folder's "global"); personal and local-only scopes
 *     are refused with a message naming the folder and how to change it;
 *     another shared scope the user can write still works.
 *   - Recall and inject read the folder's remote scope (dialled) and installed
 *     packs, never the personal local store.
 *   - The outbox stays: a failed push queues a local `_outbox` row that is
 *     removed once delivered.
 *   - A server that cannot be reached means no memory, said once — never a
 *     crash and never a silent fallback to the local store.
 *   - Folders without remote-only behave exactly as before.
 *
 * Real-HTTP stub (packages/core/test/helpers/stub-server.ts), temp PLUR home
 * and HOME only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import {
  Plur, resolveFolderPolicy, setFolderEntry, loadFolderMap, FolderMapError, RemoteOnlyWriteError,
} from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'remote-only-token'
const TEAM = 'group:acme/client'
const OTHER = 'group:acme/eng'

let server: StubServer
let baseUrl: string
beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

let base: string
let home: string
let root: string
let work: string
let personal: string
let prevHome: string | undefined

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    index: false,
    embeddings: { enabled: false },
    stores: [
      { url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false },
      { url: baseUrl, token: TOKEN, scope: OTHER, shared: true, readonly: false },
    ],
    ...extra,
  }))
}

function mapRemoteOnly(folder: string, scope = TEAM): void {
  writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: folder, plur: 'remote-only', scope }] }))
}

function primaryRows(): any[] {
  const file = join(root, 'engrams.yaml')
  if (!existsSync(file)) return []
  return ((yaml.load(readFileSync(file, 'utf8')) as { engrams?: any[] } | null)?.engrams) ?? []
}

async function installPack(plur: Plur, name: string, statement: string): Promise<void> {
  const src = join(base, `${name}-source`)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0"\n---\n`)
  writeFileSync(join(src, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0728-900
    statement: ${statement}
    type: behavioral
    scope: global
    status: active
    version: 2
    domain: ops.deploy
    tags: [deploy]
    activation:
      retrieval_strength: 0.9
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-07-28"
`)
  await plur.installPack(src)
}

beforeEach(() => {
  server.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-remote-only-')))
  home = join(base, 'home')
  root = join(home, '.plur')
  work = join(home, 'client')
  personal = join(home, 'personal')
  mkdirSync(root, { recursive: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(personal, { recursive: true })
  prevHome = process.env.HOME
  process.env.HOME = home
  writeConfig()
})

afterEach(async () => {
  await backgroundPushesSettled(root).catch(() => {})
  process.env.HOME = prevHome
  rmSync(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. The resolver gains the mode; most-specific / glob / off-wins unchanged.
// ---------------------------------------------------------------------------

describe('resolveFolderPolicy: remote-only', () => {
  it('a remote-only entry resolves to remote-only with its scope, for the folder and below', () => {
    mapRemoteOnly(work)
    mkdirSync(join(work, 'sub'))
    for (const d of [work, join(work, 'sub')]) {
      const p = resolveFolderPolicy(d, { root, home })
      expect(p.mode).toBe('remote-only')
      expect(p.scope).toBe(TEAM)
      expect(p.remoteAllowed).toBe(false)
      expect(p.source).toBe('map')
    }
  })

  it('a glob entry works; an `off` above still wins; a more specific `on` inside wins', () => {
    mkdirSync(join(work, 'inner'))
    mkdirSync(join(work, 'quiet'))
    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [
      { path: '~/client/**', plur: 'remote-only', scope: TEAM },
      { path: join(work, 'inner'), plur: 'on' },
      { path: join(work, 'quiet'), plur: 'off' },
    ] }))
    expect(resolveFolderPolicy(work, { root, home }).mode).toBe('remote-only')
    expect(resolveFolderPolicy(join(work, 'inner'), { root, home }).mode).toBe('on')
    expect(resolveFolderPolicy(join(work, 'quiet'), { root, home }).mode).toBe('off')
    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [
      { path: home, plur: 'off' },
      { path: work, plur: 'remote-only', scope: TEAM },
    ] }))
    expect(resolveFolderPolicy(work, { root, home }).mode).toBe('off')
  })

  it('beats a project marker in the folder: a repo cannot turn remote-only back into local memory', () => {
    mapRemoteOnly(work)
    writeFileSync(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    writeFileSync(join(work, '.plur.yaml'), 'scope: project:repo-hint\n')
    const p = resolveFolderPolicy(work, { root, home })
    expect(p.mode).toBe('remote-only')
    expect(p.scope).toBe(TEAM)
  })

  it('a folder without remote-only resolves exactly as before', () => {
    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [
      { path: work, plur: 'remote-only', scope: TEAM },
      { path: personal, scope: OTHER },
    ] }))
    expect(resolveFolderPolicy(personal, { root, home })).toEqual({ mode: 'on', scope: OTHER, remoteAllowed: false, source: 'map' })
    expect(resolveFolderPolicy(join(home, 'elsewhere'), { root, home }).mode).toBe('ask')
  })
})

// ---------------------------------------------------------------------------
// 1b. Recording the entry.
// ---------------------------------------------------------------------------

describe('setFolderEntry: --remote-only --scope', () => {
  it('records { plur: remote-only, scope } when a url store serves the scope', () => {
    const plur = new Plur({ path: root })
    const entry = plur.setFolder(work, { mode: 'remote-only', scope: TEAM })
    expect(entry).toEqual({ path: work, plur: 'remote-only', scope: TEAM })
    expect(loadFolderMap(root).folders).toEqual([{ path: work, plur: 'remote-only', scope: TEAM }])
  })

  it('refuses a scope no url store serves (scope-unconfigured), and a missing scope', () => {
    const plur = new Plur({ path: root })
    const refuse = (change: Parameters<Plur['setFolder']>[1]) => {
      try { plur.setFolder(work, change); return null } catch (err) { return err as FolderMapError }
    }
    expect(refuse({ mode: 'remote-only', scope: 'group:acme/nostore' })?.code).toBe('scope-unconfigured')
    // A project: scope lives in the local store: never a remote-only target.
    expect(refuse({ mode: 'remote-only', scope: 'project:local-thing' })?.code).toBe('scope-unconfigured')
    expect(refuse({ mode: 'remote-only' })?.code).toBe('invalid')
    expect(existsSync(join(root, 'folders.yaml'))).toBe(false)
    // The core function itself, with no store list: refused.
    expect(() => setFolderEntry(root, work, { mode: 'remote-only', scope: TEAM }, { configuredScopes: [TEAM] }))
      .toThrow(/url store|remote store/i)
  })
})

// ---------------------------------------------------------------------------
// 2. Writes.
// ---------------------------------------------------------------------------

describe('writes in a remote-only folder', () => {
  it('a write with no scope goes to the folder scope on the server, and leaves no local engram', async () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    const policy = plur.bindFolder(work)
    expect(policy.mode).toBe('remote-only')
    const viaRouted = await plur.learnRouted('client deploys need a signed change ticket')
    expect(viaRouted.scope).toBe(TEAM)
    const viaLearn = await plur.learn('client staging resets every Sunday night')
    expect(viaLearn.scope).toBe(TEAM)
    await backgroundPushesSettled(root)
    const onServer = server.appendStatements
    expect(onServer).toContain('client deploys need a signed change ticket')
    expect(onServer).toContain('client staging resets every Sunday night')
    expect(primaryRows().filter(e => e.status === 'active')).toEqual([])
  })

  it('personal and local-only scopes are refused, naming the folder and how to change it; nothing is written or sent', async () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['user scope', { scope: 'user:alice' }],
      ['global', { scope: 'global' }],
      ['local', { scope: 'local' }],
      ['project scope (local store)', { scope: 'project:thing' }],
      ['private visibility', { scope: TEAM, visibility: 'private' }],
    ]
    for (const [label, ctx] of attempts) {
      for (const method of ['learn', 'learnRouted'] as const) {
        let err: unknown
        try { await plur[method](`refused write ${label} ${method}`, ctx as never) } catch (e) { err = e }
        expect(err, `${label} via ${method} was not refused`).toBeInstanceOf(RemoteOnlyWriteError)
        const msg = (err as Error).message
        expect(msg).toContain(work)
        expect(msg).toContain(TEAM)
        expect(msg).toContain('plur folders set')
      }
    }
    await backgroundPushesSettled(root)
    expect(server.appendCalls).toBe(0)
    expect(primaryRows()).toEqual([])
  })

  it('a save that repeats a personal memory still goes to the team server, and the personal one is untouched', async () => {
    const seed = new Plur({ path: root })
    await seed.learn('client builds pin node 22', { scope: 'global' })
    const before = primaryRows().find(e => e.statement === 'client builds pin node 22')
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const e = await plur.learnRouted('client builds pin node 22')
    expect(e.scope).toBe(TEAM)
    expect(server.appendStatements).toContain('client builds pin node 22')
    const after = primaryRows().find(r => r.id === before.id)
    expect(after).toEqual(before)
  })

  it('another shared scope the user can write keeps working', async () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const e = await plur.learnRouted('eng-wide convention: squash merges only', { scope: OTHER })
    expect(e.scope).toBe(OTHER)
    expect(server.appendStatements).toContain('eng-wide convention: squash merges only')
  })

  it('a folder without remote-only behaves exactly as before: an unscoped write stays local', async () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    expect(plur.bindFolder(personal).mode).toBe('ask')
    const e = await plur.learn('my own shell alias for git status is gs')
    expect(e.scope).toBe('global')
    expect(primaryRows().map(r => r.statement)).toContain('my own shell alias for git status is gs')
    expect(server.appendCalls).toBe(0)
    const scoped = await plur.learn('alice prefers tabs', { scope: 'user:alice' })
    expect(scoped.scope).toBe('user:alice')
  })
})

// ---------------------------------------------------------------------------
// 3. Reads.
// ---------------------------------------------------------------------------

describe('reads in a remote-only folder', () => {
  it('recall and inject dial the folder scope and read packs, never the personal local store', async () => {
    const seed = new Plur({ path: root })
    await seed.learn('deploy checklist codeword PERSONALZEBRA lives in my notes')
    await installPack(seed, 'deploypack', 'deploy checklist codeword PACKOTTER comes from the pack')
    mapRemoteOnly(work)
    server.recallRows = [{
      id: 'ENG-2026-1001-001', scope: TEAM, status: 'active', score: 1,
      statement: 'deploy checklist codeword TEAMHERON is kept on the team server',
    }]

    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const query = 'deploy checklist codeword'
    const reads: Array<[string, () => Promise<string>]> = [
      ['recall', async () => (await plur.recall(query)).map(e => e.statement).join('\n')],
      ['recallHybrid', async () => (await plur.recallHybrid(query)).map(e => e.statement).join('\n')],
      ['inject', async () => { const r = await plur.inject(query); return [r.directives, r.constraints, r.consider].join('\n') }],
      ['injectHybrid', async () => { const r = await plur.injectHybrid(query); return [r.directives, r.constraints, r.consider].join('\n') }],
    ]
    for (const [label, read] of reads) {
      const before = server.recallCalls
      const text = await read()
      expect(server.recallCalls, `${label} did not dial the team server`).toBeGreaterThan(before)
      expect(server.lastRecallBody?.scopes, label).toEqual([TEAM])
      expect(text, `${label} missed the team row`).toContain('TEAMHERON')
      expect(text, `${label} missed the pack`).toContain('PACKOTTER')
      expect(text, `${label} read the personal store`).not.toContain('PERSONALZEBRA')
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Outbox.
// ---------------------------------------------------------------------------

describe('outbox in a remote-only folder', () => {
  it('a failed push queues a local _outbox row; delivery removes it', async () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    const queued = await plur.learnRouted('client hotfixes go out through the release train')
    await backgroundPushesSettled(root)
    const rows = primaryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(queued.id)
    expect(rows[0].scope).toBe(TEAM)
    expect(rows[0].structured_data?._outbox?.target_scope).toBe(TEAM)

    server.appendErrorResponse = null
    const flushed = await plur.flushOutbox({ force: true })
    expect(flushed.flushed).toBe(1)
    expect(server.appendStatements).toContain('client hotfixes go out through the release train')
    expect(primaryRows().filter(e => e.status === 'active' && e.structured_data?._outbox)).toEqual([])
    expect(primaryRows().filter(e => e.statement === 'client hotfixes go out through the release train' && e.status === 'active')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Offline.
// ---------------------------------------------------------------------------

describe('offline team server', () => {
  it('inject returns no memory and says the server was not reached; it never falls back to the local store', async () => {
    const seed = new Plur({ path: root })
    await seed.learn('offline codeword PERSONALZEBRA is personal')
    mapRemoteOnly(work)
    server.recallStatus = 503
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    for (const run of [() => plur.inject('offline codeword'), () => plur.injectHybrid('offline codeword')]) {
      const r = await run()
      expect(r.count).toBe(0)
      expect([r.directives, r.constraints, r.consider].join('')).not.toContain('PERSONALZEBRA')
      expect(r.remote_only).toBeDefined()
      expect(r.remote_only!.served).toBe(false)
      expect(r.remote_only!.scope).toBe(TEAM)
      expect(r.remote_only!.folder).toBe(work)
    }
  })

  it('an unreachable server (nothing listening) is the same: no crash, no memory, not served', async () => {
    mapRemoteOnly(work)
    writeFileSync(join(root, 'config.yaml'), yaml.dump({
      index: false, embeddings: { enabled: false },
      stores: [{ url: 'http://127.0.0.1:9', token: TOKEN, scope: TEAM, shared: true, readonly: false }],
    }))
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const r = await plur.inject('anything at all', { remote_timeout_ms: 500 })
    expect(r.count).toBe(0)
    expect(r.remote_only?.served).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. The commented template and comment-preserving writes.
// ---------------------------------------------------------------------------

describe('folders.yaml template', () => {
  it('the first write creates it with a commented example of every setting, each explained', () => {
    const plur = new Plur({ path: root })
    plur.setFolder(personal, { mode: 'on' })
    const text = readFileSync(join(root, 'folders.yaml'), 'utf8')
    const commented = text.split('\n').filter(l => /^\s*#/.test(l)).join('\n')
    for (const [setting, line] of [
      ['on', /#\s+plur:\s+on\s+#\s*on: \S/],
      ['off', /#\s+plur:\s+off\s+#\s*off: \S/],
      ['ask', /#\s+plur:\s+ask\s+#\s*ask: \S/],
      ['scope', /#\s+scope:\s+\S+\s+#\s*scope: \S/],
      ['trusted', /#\s+trusted:\s+true\s+#\s*trusted: \S/],
      ['remote-only', /#\s+plur:\s+remote-only\s+#\s*remote-only: \S/],
    ] as const) {
      expect(commented, `no commented example for ${setting}`).toMatch(line)
    }
    // Only the real entry is live.
    expect(loadFolderMap(root).folders).toEqual([{ path: personal, plur: 'on' }])
  })

  it('uncommenting the examples gives a valid map with every setting', () => {
    const plur = new Plur({ path: root })
    plur.setFolder(personal, { mode: 'on' })
    const text = readFileSync(join(root, 'folders.yaml'), 'utf8')
    const uncommented = text
      .split('\n')
      .map(l => l.replace(/^(\s*)# (\s*- path: |\s+(plur|scope|trusted):)/, '$1$2'))
      .join('\n')
      .replace(/^folders: \[\]/m, 'folders:')
    writeFileSync(join(root, 'folders.yaml'), uncommented)
    const entries = loadFolderMap(root).folders
    const modes = new Set(entries.map(e => e.plur).filter(Boolean))
    for (const m of ['on', 'off', 'ask', 'remote-only']) expect(modes.has(m as never), m).toBe(true)
    expect(entries.some(e => e.scope && e.plur === undefined)).toBe(true)
    expect(entries.some(e => e.trusted === true)).toBe(true)
    expect(entries.some(e => e.plur === 'remote-only' && e.scope)).toBe(true)
    expect(entries.some(e => e.path === personal && e.plur === 'on')).toBe(true)
  })
})

describe('CLI writes keep comments and order', () => {
  let a: string, b: string, c: string, d: string
  let original: string
  beforeEach(() => {
    a = join(home, 'a'); b = join(home, 'b'); c = join(home, 'c'); d = join(home, 'd')
    for (const p of [a, b, c, d]) mkdirSync(p)
    original = [
      '# my folder decisions',
      '# (hand-written)',
      'version: 1',
      'folders:',
      '  # the work repo',
      `  - path: ${a}   # alpha`,
      `    scope: ${OTHER}   # the eng team`,
      '  # second one',
      `  - path: ${b}`,
      '    plur: off   # noisy',
      `  - path: ${c}`,
      '    trusted: true   # granted after review',
      '# trailing note',
      '',
    ].join('\n')
    writeFileSync(join(root, 'folders.yaml'), original)
  })
  const text = () => readFileSync(join(root, 'folders.yaml'), 'utf8')

  it('set changes only the entry it names', () => {
    new Plur({ path: root }).setFolder(b, { mode: 'ask' })
    expect(text()).toBe(original.replace('    plur: off   # noisy', '    plur: ask   # noisy'))
  })

  it('set of a new folder appends it after the last entry', () => {
    new Plur({ path: root }).setFolder(d, { mode: 'remote-only', scope: TEAM })
    expect(text()).toBe(original.replace(
      '    trusted: true   # granted after review\n',
      `    trusted: true   # granted after review\n  - path: ${d}\n    plur: remote-only\n    scope: ${TEAM}\n`,
    ))
  })

  it('rm removes only that entry', () => {
    expect(new Plur({ path: root }).removeFolder(b)).toBe(true)
    expect(text()).toBe(original.replace(`  - path: ${b}\n    plur: off   # noisy\n`, ''))
  })

  it('trust adds the grant to the entry and nothing else', () => {
    new Plur({ path: root }).trustDirectory(a)
    expect(text()).toBe(original.replace(
      `    scope: ${OTHER}   # the eng team\n`,
      `    scope: ${OTHER}   # the eng team\n    trusted: true\n`,
    ))
  })

  it('untrust removes the grant (and an entry left with no decision) and nothing else', () => {
    expect(new Plur({ path: root }).untrustDirectory(c)).toBe(true)
    expect(text()).toBe(original.replace(`  - path: ${c}\n    trusted: true   # granted after review\n`, ''))
  })

  it('a malformed folders.yaml is never overwritten', () => {
    writeFileSync(join(root, 'folders.yaml'), 'folders: [[[')
    expect(() => new Plur({ path: root }).setFolder(d, { mode: 'on' })).toThrow(FolderMapError)
    expect(text()).toBe('folders: [[[')
  })
})

// ---------------------------------------------------------------------------
// Owner decisions on #1521 (2026-10-01).
// ---------------------------------------------------------------------------

describe('decision 2: --scope alone on a remote-only entry keeps it remote-only', () => {
  it('changes only the scope; it never switches the folder back to local memory', () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    expect(plur.setFolder(work, { scope: OTHER })).toEqual({ path: work, plur: 'remote-only', scope: OTHER })
    expect(resolveFolderPolicy(work, { root, home }).mode).toBe('remote-only')
  })

  it('the new scope must still be served by a url store; nothing changes when it is not', () => {
    mapRemoteOnly(work)
    const before = readFileSync(join(root, 'folders.yaml'), 'utf8')
    const plur = new Plur({ path: root })
    let err: unknown
    try { plur.setFolder(work, { scope: 'project:local-thing' }) } catch (e) { err = e }
    expect((err as FolderMapError)?.code).toBe('scope-unconfigured')
    expect(readFileSync(join(root, 'folders.yaml'), 'utf8')).toBe(before)
  })

  it('leaving remote-only takes an explicit mode (or rm)', () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    expect(plur.setFolder(work, { mode: 'on' }).plur).toBe('on')
    expect(resolveFolderPolicy(work, { root, home }).mode).toBe('on')
  })
})

describe('decision 3: a remote-only entry with no scope keeps refusing', () => {
  it('every write is refused with a message naming the folder; injection says there is no team server', async () => {
    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only' }] }))
    const plur = new Plur({ path: root })
    expect(plur.bindFolder(work).mode).toBe('remote-only')
    for (const ctx of [undefined, { scope: OTHER }]) {
      let err: unknown
      try { await plur.learnRouted('no scope here', ctx) } catch (e) { err = e }
      if (ctx === undefined) {
        expect(err).toBeInstanceOf(RemoteOnlyWriteError)
        expect((err as Error).message).toContain(work)
        expect((err as Error).message).toMatch(/names no team scope/)
      }
    }
    const r = await plur.inject('anything')
    expect(r.remote_only).toMatchObject({ served: false, reason: 'no-scope', scope: null })
    expect(primaryRows().filter(e => e.statement === 'no scope here' && !e.structured_data?._outbox)).toEqual([])
  })
})

describe('decision 4: no session timeline in a remote-only folder', () => {
  it('capture is refused and writes no episode; elsewhere it works as before', () => {
    mapRemoteOnly(work)
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    let err: unknown
    try { plur.capture('client session summary with private details') } catch (e) { err = e }
    expect(err).toBeInstanceOf(RemoteOnlyWriteError)
    expect((err as Error).message).toContain(work)
    const episodes = join(root, 'episodes.yaml')
    expect(existsSync(episodes) ? readFileSync(episodes, 'utf8') : '').not.toContain('client session summary')
    plur.bindFolder(personal)
    expect(plur.capture('a personal session summary').summary).toBe('a personal session summary')
  })
})
