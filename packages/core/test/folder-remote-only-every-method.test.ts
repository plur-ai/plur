/**
 * Re-audit of #1521 (owner, 2026-10-01): the remote-only guarantee is checked
 * against EVERY public Plur method, not a hand-picked list.
 *
 * A store is seeded with personal content — a primary row, a pinned row, a
 * row in a local secondary file store, a timeline episode — and a remote-only
 * folder is bound. Every method on Plur.prototype is called. Then:
 *   - no return value (or error message) carries a personal statement;
 *   - no permanent (non-queued) row was created or modified in any local
 *     store, and the timeline is unchanged.
 *
 * A method added later fails this test until it is given arguments here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'every-method-token'
const TEAM = 'group:acme/client'
const MARKERS = ['PERSONALZEBRA', 'PERSONALPIN', 'PERSONALSECOND', 'PERSONALEPISODE']

let server: StubServer
let baseUrl: string
let base: string, home: string, root: string, work: string, secondary: string
let prevHome: string | undefined

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-every-')))
  home = join(base, 'home'); root = join(home, '.plur'); work = join(home, 'client')
  secondary = join(root, 'mine.yaml')
  mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
  prevHome = process.env.HOME; process.env.HOME = home
})
afterAll(async () => {
  await backgroundPushesSettled(root).catch(() => {})
  process.env.HOME = prevHome
  await server.stop()
  rmSync(base, { recursive: true, force: true })
})

function primaryRows(): any[] {
  const f = join(root, 'engrams.yaml')
  if (!existsSync(f)) return []
  return ((yaml.load(readFileSync(f, 'utf8')) as { engrams?: any[] } | null)?.engrams) ?? []
}
const permanent = () => primaryRows().filter(r => !r.structured_data?._outbox)
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')

describe('every public Plur method in a remote-only folder', () => {
  it('returns no personal statement and creates or changes no permanent row', async () => {
    writeFileSync(join(root, 'config.yaml'), yaml.dump({
      index: false, embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false }],
    }))
    // --- personal content, written outside the folder ---
    const outside = new Plur({ path: root })
    const personal = await outside.learn('always see my dentist PERSONALZEBRA on Tuesday', { domain: 'personal.health' })
    const pinned = await outside.learn('always PERSONALPIN rule for me')
    await outside.setPinned(pinned.id, true)
    await outside.inject('dentist PERSONALZEBRA')
    await outside.inject('dentist PERSONALZEBRA again')
    const episode = outside.capture('my session about PERSONALEPISODE')
    const personalRow = primaryRows().find(r => r.id === personal.id)
    writeFileSync(secondary, yaml.dump({ engrams: [{ ...personalRow, id: 'ENG-2026-10-01-050', scope: 'project:mine', statement: 'second store PERSONALSECOND fact' }] }))
    writeFileSync(join(root, 'config.yaml'), yaml.dump({
      index: false, embeddings: { enabled: false },
      stores: [
        { url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false },
        { path: secondary, scope: 'project:mine' },
      ],
    }))
    const rec = await outside.recordTensions([{ id_a: personal.id, id_b: pinned.id, statement_a: personalRow.statement, statement_b: 'always PERSONALPIN rule for me', confidence: 0.9, reason: 'x' }])
    const tensionId = rec.records[0].id
    // A pack that contradicts a personal memory (installPack reports conflicts,
    // quoting the existing statement).
    const pack = join(base, 'pack-src')
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'SKILL.md'), '---\nname: conflictpack\nversion: "1.0"\n---\n')
    writeFileSync(join(pack, 'engrams.yaml'), yaml.dump({ engrams: [{ ...personalRow, id: 'ENG-2026-0101-001', scope: 'global', domain: 'personal.health', statement: 'never see the dentist on Tuesday mornings' }] }))
    // A history event and a stale content hash on the personal row.
    const stale = primaryRows()
    stale.find(r => r.id === personal.id).content_hash = 'deadbeef'
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: stale }))

    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
    const beforePermanent = JSON.stringify(permanent())
    const beforeSecondary = read(secondary)
    const beforeEpisodes = read(join(root, 'episodes.yaml'))
    const beforeTensions = read(join(root, 'tensions.yaml'))

    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    expect(plur.remoteOnlyFolder()?.scope).toBe(TEAM)
    const llm = async () => '[]'
    const pid = personal.id
    const row = { ...personalRow, statement: 'rewritten in the client folder' }

    // Every member of Plur.prototype, with the arguments it is called with.
    // `null` = deliberately not called here, with the reason.
    const CALLS: Record<string, unknown[] | null> = {
      close: null, // called last, below
      bindFolder: null, bindFolderPolicy: null, bindFolderUnresolved: null, // change the binding under test
      backendSelection: [], provenanceFor: [pid], writeProvenance: [pid], identity: [], setIdentity: ['someone'],
      getScopeMetadata: [TEAM], listScopeMetadata: [], previewAutoRoute: [{ statement: 'x' }], suggestScope: [{ statement: 'x' }],
      getScopeRoutingConfig: [], wouldDeduplicate: [personalRow.statement], dedupScopeFor: [personalRow.statement],
      learn: ['team fact one'], nearDuplicates: ['dentist PERSONALZEBRA'], learnRouted: ['team fact two'],
      deliveryOf: [personalRow], readIdFor: [personalRow], learnAsync: ['team fact three'],
      learnBatch: [[{ statement: 'team batch fact' }]],
      recall: ['dentist PERSONALZEBRA'], recallAsync: ['dentist PERSONALZEBRA', { llm }], recallSemantic: ['dentist PERSONALZEBRA'],
      recallHybrid: ['dentist PERSONALZEBRA'], recallHybridWithMeta: ['dentist PERSONALZEBRA'],
      rerankerSelfEval: [], rerankerEvalStatus: [], checkRerankerFit: [], embedderStatus: [], resetEmbedder: [],
      rerankerStatus: [], resetReranker: [], similaritySearch: ['dentist PERSONALZEBRA'],
      recallExpanded: ['dentist PERSONALZEBRA', { llm }], recallAutoSearch: ['dentist PERSONALZEBRA'],
      getById: [pid], getByIds: [[pid, pinned.id, 'ENG-PMI-2026-10-01-050']], list: [], ready: [],
      remoteHealthStatePath: [], outboxIdMapPath: [], outboxClaimsDir: [], remoteStoreStatus: [], noteRemoteHostReachable: [baseUrl],
      remoteEndpointTokenConflicts: [], inject: ['dentist PERSONALZEBRA'], injectHybrid: ['dentist PERSONALZEBRA'],
      feedback: [pid, 'positive'], saveMetaEngrams: [[{ ...personalRow, id: 'META-2026-1001-001' }]],
      updateEngram: [row], updateEngramAsync: [row], setPinned: [pid, true], setPinnedAsync: [pid, true],
      listPinned: [], hardTierCap: [], pinnedQuota: [], repairContentHashes: [{ apply: true }],
      forget: [pid], rescope: [pid, 'local'], compact: [], reindex: [], reindexAsync: [], lastIndexError: [], waitForIndex: [],
      capture: ['client session'], timeline: [], ingest: ['notes about the dentist PERSONALZEBRA'],
      previewPack: [pack], installPack: [pack], uninstallPack: ['conflictpack'],
      exportPack: [[], join(base, 'export-out'), { name: 'x', version: '1.0', license: 'MIT' }], listPacks: [],
      migratePackIntegrity: [{ dryRun: true }], getStorageRoot: [], sync: [], syncStatus: [], outboxCount: [], listOutbox: [],
      outboxSummary: [], flushOutbox: [{ force: true }], episodeToEngram: [episode.id], getEngramHistory: [pid],
      reportFailure: [pid, 'it failed'], status: [], receipt: [], listTensions: [], suppressedTensionPairKeys: [],
      recordTensions: [[{ id_a: pid, id_b: pinned.id, statement_a: 'a', statement_b: 'b', confidence: 0.9, reason: 'x' }]],
      confirmTension: [tensionId], dismissTension: [tensionId], resolveTension: [tensionId, pid], hasUnresolvedTension: [pid],
      getTensionsConfig: [], purgeTensions: [], statConfigMtime: [], ignoredDuplicateStores: [], removeDuplicatePrimaryStores: [],
      reloadConfigIfChanged: [], persistStores: null, mergeStoresForWriteback: null, persistDismissedScopes: null, // config writers, no engram store access
      addStore: [join(base, 'nope.yaml'), 'project:nope'], addRemoteStore: [{ url: 'http://127.0.0.1:9', scope: 'group:nope/x' }],
      verifyRemoteStore: [{ url: baseUrl, token: TOKEN, scope: TEAM }], autoDiscoveryEnabled: [], isDirectoryTrusted: [work],
      trustDirectory: [join(base, 'elsewhere')], untrustDirectory: [join(base, 'elsewhere')], listTrustedDirectories: [],
      coveringTrustedAncestor: [work], resolveFolderPolicy: [work], remoteOnlyFolder: [], listFolders: [],
      setFolder: [join(base, 'elsewhere'), { mode: 'off' }], removeFolder: [join(base, 'elsewhere')],
      issueFolderNonce: ['s1', join(base, 'elsewhere'), { mode: 'on' }], endFolderNonceSession: ['s1'],
      autoDiscoverStores: [work], listStores: [], listStoresAsync: [], warmRemoteCaches: [], getWritableRemoteScopes: [],
      remoteEndpointTokenGroups: [], discoverRemoteScopes: [], remoteTokenExpiries: [], checkRemoteHealth: [],
      registerDiscoveredScopes: [], offerableScopes: [], registerScope: ['group:nope/y'], dismissScope: ['group:nope/z'],
      reofferScopes: [], getDismissedScopes: [], persistScopeMetadata: [[]], setSessionScope: [null], adjustSessionScope: [null],
      getSessionScope: [], clearSessionScope: [], trackedSessionScopes: [],
    }
    const names = Object.getOwnPropertyNames(Plur.prototype).filter(n => n !== 'constructor' && !n.startsWith('_'))
    const getters = names.filter(n => Object.getOwnPropertyDescriptor(Plur.prototype, n)!.get)
    const methods = names.filter(n => !getters.includes(n))
    expect(methods.filter(n => !(n in CALLS)), 'methods with no entry in CALLS').toEqual([])

    const leaks: string[] = []
    const check = (name: string, value: unknown) => {
      let text = ''
      try { text = JSON.stringify(value) ?? String(value) } catch { text = String(value) }
      for (const m of MARKERS) if (text.includes(m)) leaks.push(`${name} → ${m}`)
    }
    for (const name of methods) {
      const args = CALLS[name]
      if (!args) continue
      let out: unknown
      try {
        out = await Promise.race([
          (plur as any)[name](...args),
          new Promise(r => setTimeout(() => r('(timed out)'), 20_000)),
        ])
      } catch (err) {
        out = (err as Error)?.message ?? String(err)
      }
      check(name, out)
    }
    for (const g of getters) {
      const v = (plur as any)[g]
      if (g === 'primaryStore') {
        check('primaryStore.load', await v.load())
        check('primaryStore.loadCached', await v.loadCached())
      } else check(g, v)
    }
    await backgroundPushesSettled(root).catch(() => {})
    expect(leaks).toEqual([])
    expect(JSON.stringify(permanent())).toBe(beforePermanent)
    expect(read(secondary)).toBe(beforeSecondary)
    expect(read(join(root, 'episodes.yaml'))).toBe(beforeEpisodes)
    expect(read(join(root, 'tensions.yaml'))).toBe(beforeTensions)
    plur.close()
  }, 600_000)
})
