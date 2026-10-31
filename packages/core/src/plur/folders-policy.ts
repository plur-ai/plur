import * as fs from 'fs'
import yaml from 'js-yaml'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { namespaceEngramId } from '../engrams.js'
import { escapedPath as folderEscaped } from '../folder-ask.js'
import {
    answerFolderNotNow as _answerFolderNotNow,
    endFolderNonceSession as _endFolderNonceSession,
    hasOwnFolderDecision as _hasOwnFolderDecision,
    issueFolderNonce as _issueFolderNonce,
    isTrustedInMap as _isTrustedInMap,
    loadFolderMap as _loadFolderMap,
    removeFolderEntry as _removeFolderEntry,
    resolveFolderPolicy as _resolveFolderPolicy,
    setFolderEntry as _setFolderEntry,
    type FolderAnswer,
    type FolderChange,
    type FolderEntry,
    type FolderPolicy,
} from '../folders.js'
import { loadGitScopeSources, readGitOrigin, type GitScopeOutcome, type GitScopeSource } from '../git-origin.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { canonicalize } from '../project-config.js'
import {
    RemoteOnlyWriteError,
    type RemoteOnlyBinding,
    type RemoteOnlyRefusal
} from '../remote-only.js'
import { formatServerSessionLine, type ServerSessionState } from '../save-destination.js'
import type { Engram } from '../schemas/engram.js'
import { isScopeWithin, isSharedScope } from '../scope-util.js'
import { resolveScopeTarget } from '../store-resolver.js'
import { isQueuedForFolder } from '../store/remote-only-store-guard.js'
import { normalizeEndpointUrl } from '../store/remote-store.js'
import { YamlPrimaryStore } from '../store/yaml-primary-store.js'
import {
    coveringTrustedAncestor as _coveringTrustedAncestor,
    isDirectoryTrusted as _isDirectoryTrusted,
    listTrustedDirectories as _listTrustedDirectories,
    trustDirectory as _trustDirectory,
    untrustDirectory as _untrustDirectory,
} from '../trust.js'
import { isEnterpriseServerEntry, isPlainObject, isUnder, REMOTE_PROBE_TIMEOUT_MS } from './helpers.js'

export interface FoldersPolicyMethods {
  /** Whether this instance ran (and would re-run) cwd store discovery. */
  autoDiscoveryEnabled(): boolean

  /**
   * True when `dir` (or an ancestor of it) has been explicitly trusted via
   * `trustDirectory` / `plur trust`.
   *
   * This is the gate an ADAPTER (opencode, claw, ...) should check before
   * adopting behaviour-changing configuration it finds on disk — a
   * `.plur.yaml` `scope`/`domain`, for instance — from a directory it did not
   * create and the user may not have vetted. It is deliberately NOT about
   * whether the scope is local or remote: a remote/team store is the
   * legitimate reason a project declares a scope at all, so the gate is on
   * the DIRECTORY, the same way `direnv allow` / `git config safe.directory`
   * / VS Code workspace trust gate on the directory rather than on what the
   * config inside it says.
   */
  isDirectoryTrusted(dir: string): boolean

  /**
   * Grant trust to `dir` (`plur trust`). Returns the canonicalized path
   * recorded. A `nonce` must be one issued for `dir` and `{ trusted: true }`.
   */
  trustDirectory(dir: string, options?: { nonce?: string; session?: string }): string

  /**
   * Revoke trust from `dir` (`plur untrust`). Returns whether an entry was
   * removed. Needs no nonce: a revocation only removes trust.
   */
  untrustDirectory(dir: string): boolean

  /** List every directory this user has explicitly trusted. */
  listTrustedDirectories(): string[]

  /**
   * Find the trusted entry — `dir` itself or a covering ancestor — that
   * makes `isDirectoryTrusted(dir)` true. `null` when nothing covers it.
   * See trust.ts's `coveringTrustedAncestor`: this is
   * what `plur untrust` uses to avoid claiming a directory is untrusted
   * when an ancestor's grant still covers it.
   */
  coveringTrustedAncestor(dir: string): string | null

  /**
   * What PLUR does in `dir` according to the folder map, `.plur.yaml` and
   * project MCP configs. Keyed on this instance's root.
   */
  resolveFolderPolicy(dir: string, options?: { home?: string; readOnly?: boolean }): FolderPolicy

  gitScopeSources(): GitScopeSource[]

  folderDefaultScope(dir: string): { mode: FolderPolicy['mode']; scope: string | null; git: GitScopeOutcome | null }

  /** Cached server status; async only because primary outbox storage is async. */
  serverSessionLines(dir: string, admittedPolicy?: FolderPolicy): Promise<string[]>

  /**
   * Resolve the folder policy for `dir` and bind this instance to it
   * (`bindFolderPolicy`). Adapters call this with the folder the session runs
   * in; only `remote-only` changes what the instance does.
   */
  bindFolder(dir: string, options?: { home?: string }): FolderPolicy

  /**
   * Bind this instance to an already-resolved folder policy. A `remote-only`
   * policy puts the instance in remote-only mode; any other mode clears it, so a long-lived process (the MCP
   * server) follows the map as it changes.
   */
  bindFolderPolicy(dir: string, policy: FolderPolicy): void

  /**
   * Bind to a folder whose decision could not be resolved at all: fail CLOSED
   * — nothing is read or written until a later bind
   * succeeds.
   */
  bindFolderUnresolved(dir: string, why: string): void

  /** @internal */
  _remoteOnlyError(refusal: RemoteOnlyRefusal, requested?: string, detail?: string): RemoteOnlyWriteError

  /** remote-only: refuse `op` on a row this machine's primary store holds. */
  /** @internal */
  _remoteOnlyRefuseLocalRow(id: string, op: string, scope?: string): Promise<void>

  /** remote-only: refuse an operation on the personal store as a whole. */
  /** @internal */
  _remoteOnlyRefuseLocalStore(op: string): void

  /** remote-only: the rows an id lookup may answer from — team rows, packs and queued saves; never personal rows. */
  /** @internal */
  _remoteOnlyVisible(): Promise<Engram[]>

  /** @internal */
  _queuedStaysRemote(e: Engram): RemoteOnlyWriteError

  /** The remote-only folder this instance is bound to, or null. */
  remoteOnlyFolder(): RemoteOnlyBinding | null

  /** The folder map entries, in file order. */
  listFolders(): FolderEntry[]

  /**
   * Record a decision for `folder` (`plur folders set`). A shared scope must
   * name a store configured in config.yaml; a `nonce` (from the ask flow)
   * must be the one issued for this folder. Throws FolderMapError on refusal.
   */
  setFolder(folder: string, change: FolderChange, options?: { nonce?: string; session?: string; home?: string; literal?: boolean; refuseCoveringHome?: boolean }): FolderEntry

  /** Remove the exact entry for `folder` (`plur folders rm`); `nonce` as for setFolder. */
  removeFolder(folder: string, options?: { nonce?: string; session?: string }): boolean

  /**
   * Issue a single-use nonce for the ask flow of `sessionId` that authorises
   * exactly `answer` on exactly `folder`. The ask flow issues one per
   * answer it offers; see folders.ts issueFolderNonce.
   */
  issueFolderNonce(sessionId: string, folder: string, answer: FolderAnswer, options?: { home?: string; literal?: boolean; bindSession?: boolean }): string

  /** Expire every folder nonce of `sessionId` (call at session end). */
  endFolderNonceSession(sessionId: string): void

  /**
   * The MCP folder question's "not now" (`plur folders set --not-now`):
   * consume the nonce issued for that answer on `folder`; nothing is written
   * to the folder map. See folders.ts answerFolderNotNow.
   */
  notNowFolder(folder: string, options: { nonce: string; session?: string }): void

  /**
   * Whether discovery is skipped because the PLUR root is a temp folder (a
   * test-safety guard): the root as given
   * (not resolved, so a user's symlink is not followed) starts with the OS
   * temp folder or with `/tmp/`. `PLUR_TEST_DISCOVER_IN_TMP=1` is a TEST-ONLY
   * switch that turns the skip off, so tests that build their tree under the
   * system temp folder can exercise real discovery; nothing sets it for users.
   */
  /** @internal */
  _discoverySkippedForTempRoot(): boolean

  /**
   * The `.plur/engrams.yaml` stores discovery looks at from `startDir`
   * upward, with the same bounds as {@link autoDiscoverStores}: never the
   * home folder or above it, stopping at the repository root (`.git`)
   * or the filesystem root; never the active store or `~/.plur`; never a
   * store config.yaml already lists. Read-only.
   */
  /** @internal */
  _discoveryCandidates(startDir: string): Array<{ dir: string; typed: string | null; candidate: string; key: string }>

  /**
   * True when the start folder is off by either its path as typed or its real
   * path: then discovery adopts nothing and lists
   * nothing, whatever the folders above it say. Through a link into a
   * repository's sub-folder, the per-candidate spellings cannot see the
   * alias that the user turned off.
   */
  /** @internal */
  _startFolderOff(startDir: string): boolean

  autoDiscoverStores(cwd?: string): Array<{ path: string; scope: string }>

  /**
   * Project stores discovery found from `cwd` but did not add because their
   * folder has no decision of its own: the folder is on
   * only through a parent, or not decided yet. A folder turned off is not
   * listed. Read-only; `plur doctor` and `plur stores list` show these with
   * the command that adds them (`plur folders set <folder> --on`).
   */
  skippedProjectStores(cwd?: string): Array<{ path: string; folder: string }>
}

export const foldersPolicyMethods: FoldersPolicyMethods & ThisType<Plur> = {
  autoDiscoveryEnabled(): boolean {
    return this._autoDiscover
  },

  isDirectoryTrusted(dir: string): boolean {
    return _isDirectoryTrusted(dir, this.paths.root)
  },

  trustDirectory(dir: string, options?: { nonce?: string; session?: string }): string {
    return _trustDirectory(dir, this.paths.root, options)
  },

  untrustDirectory(dir: string): boolean {
    return _untrustDirectory(dir, this.paths.root)
  },

  listTrustedDirectories(): string[] {
    return _listTrustedDirectories(this.paths.root)
  },

  coveringTrustedAncestor(dir: string): string | null {
    return _coveringTrustedAncestor(dir, this.paths.root)
  },

  resolveFolderPolicy(dir: string, options?: { home?: string; readOnly?: boolean }): FolderPolicy {
    return _resolveFolderPolicy(dir, {
      root: this.paths.root,
      gitScopes: loadGitScopeSources(this.paths.root),
      readOrigin: d => {
        const path = canonicalize(d)
        const now = Date.now()
        const cached = this._gitOrigins.get(path)
        if (cached && now >= cached.at && now - cached.at < 30_000) return cached.origin
        const origin = readGitOrigin(path)
        // Bound memory for long-lived clients that visit many folders.
        if (this._gitOrigins.size >= 256) this._gitOrigins.clear()
        this._gitOrigins.set(path, { at: now, origin })
        return origin
      },
      ...(options?.home ? { home: options.home } : {}),
      ...(options?.readOnly ? { readOnly: true } : {}),
    })
  },

  gitScopeSources(): GitScopeSource[] {
    return loadGitScopeSources(this.paths.root)
  },

  folderDefaultScope(dir: string): { mode: FolderPolicy['mode']; scope: string | null; git: GitScopeOutcome | null } {
    const policy = this.resolveFolderPolicy(dir, { readOnly: true })
    return { mode: policy.mode, scope: policy.scope ?? null, git: policy.git ?? null }
  },

  async serverSessionLines(dir: string, admittedPolicy?: FolderPolicy): Promise<string[]> {
    this.reloadConfigIfChanged()
    const entries = this._readRawStores().filter(isEnterpriseServerEntry)
    if (!entries.length) return []
    const policy = admittedPolicy ?? this.resolveFolderPolicy(dir, { readOnly: true })
    const queued = (await this.listOutbox()).filter(e => e.kind === 'push')
    // A grant may disappear while its save is still queued. Match durable
    // endpoint evidence, not a mutable scopes list. Keep endpoints private.
    const originalTargets = new Map<string, string>()
    if (queued.length) for (const row of await this._loadCached(this.paths.engrams)) {
      const url = (row as any).structured_data?._outbox?.target_url
      if (typeof url === 'string') originalTargets.set(row.id, normalizeEndpointUrl(url))
    }
    return entries.map(entry => {
      const cache = isPlainObject(entry.discovery) ? entry.discovery : {}
      const waiting = queued.filter(e => {
        const current = this._remoteWriteEntry(e.target_scope)?.url
        const target = current ? normalizeEndpointUrl(current) : originalTargets.get(e.id)
        return target === normalizeEndpointUrl(entry.url)
      })
      const action = waiting.find(e => e.state === 'needs_action')
      const dates = waiting.map(e => e.queued_at).filter(d => Number.isFinite(Date.parse(d))).sort()
      const status = (['ok', 'not_synced', 'failed', 'auth_failed', 'degraded'] as const).find(s => s === cache.status) ?? 'never'
      // An agreed explicit/effective scope outranks how individual roots
      // obtained it. Remote-only also keeps its scope above Git defaults.
      const target: ServerSessionState['target'] = policy.scope ? { kind: 'map', scope: policy.scope } : policy.git ?? null
      const targetScope = target?.kind === 'scope' || target?.kind === 'map' ? target.scope : undefined
      const route = targetScope ? resolveScopeTarget(targetScope, this.config.stores ?? []) : undefined
      const writeWarning = route?.kind === 'remote' && route.entry.readonly
        ? `the store for ${targetScope} is read-only`
        : route?.kind === 'conflict' ? `more than one server claims ${targetScope}; choose a single store`
        : route?.kind === 'unauthorized' ? `${targetScope} is not granted to you on this server`
        : route?.kind === 'local' ? `saves for ${targetScope} stay on this laptop; no writable server store is registered`
        : route?.kind === 'remote' && normalizeEndpointUrl(route.entry.url!) !== normalizeEndpointUrl(entry.url)
          ? 'this repository saves to another server' : undefined
      return formatServerSessionLine({
        host: normalizeEndpointUrl(entry.url),
        username: typeof cache.username === 'string' ? cache.username : undefined,
        status,
        target, writeWarning,
        keyExpiresAt: cache.key_expires_at === null || typeof cache.key_expires_at === 'string' ? cache.key_expires_at : undefined,
        ...(waiting.length ? { queued: {
          count: waiting.length, since: dates[0]?.slice(0, 10) ?? 'an unknown date', needsAction: !!action,
          ...(action && action.last_status !== 401 && action.last_status !== 403 ? { reason: 'the queued save needs attention' } : {}),
        } } : {}),
      })
    })
  },

  bindFolder(dir: string, options?: { home?: string }): FolderPolicy {
    // Binding only looks: it never imports a legacy trust.yaml.
    const policy = this.resolveFolderPolicy(dir, { ...options, readOnly: true })
    this.bindFolderPolicy(dir, policy)
    return policy
  },

  bindFolderPolicy(dir: string, policy: FolderPolicy): void {
    this._boundGit = policy.mode === 'on' ? policy.git : undefined
    if (policy.reason === 'malformed-map' || policy.reason === 'resolver-error') {
      // Fail safe: the map may hold an
      // `off` or a remote-only decision we cannot see, so read and write nothing.
      const where = policy.mapError
      const why = policy.reason === 'resolver-error'
        ? `the folder decision for ${folderEscaped(dir)} could not be resolved`
        : where
          ? `the folder map ${folderEscaped(where.file)}${where.line !== undefined ? ` (line ${where.line})` : ''} could not be read`
          : 'the folder map could not be read'
      this._boundFolder = { folder: dir, scope: null, blocked: why }
      return
    }
    this._boundFolder = policy.mode === 'remote-only' ? { folder: dir, scope: policy.scope ?? null } : null
  },

  bindFolderUnresolved(dir: string, why: string): void {
    this._boundGit = undefined
    this._boundFolder = { folder: dir, scope: null, blocked: `the folder decision for ${folderEscaped(dir)} could not be resolved (${folderEscaped(why)})` }
  },

  _remoteOnlyError(refusal: RemoteOnlyRefusal, requested?: string, detail?: string): RemoteOnlyWriteError {
    const ro = this._remoteOnly!
    if (ro.blocked) return new RemoteOnlyWriteError(ro.folder, ro.scope, requested, 'blocked', ro.blocked)
    return new RemoteOnlyWriteError(ro.folder, ro.scope, requested, refusal, detail)
  },

  async _remoteOnlyRefuseLocalRow(id: string, op: string, scope?: string): Promise<void> {
    if (!this._remoteOnly) return
    if (this._remoteOnly.blocked) throw this._remoteOnlyError('local-row')
    // An explicit url-store scope routes to that store, not to a local row
    // that happens to share the id.
    if (scope && this._isRemoteBackedScope(scope)) {
      // Only the folder's team scope or another TEAM scope; a personal url
      // store (`user:`…) is out of reach here.
      if (!this._isDeliverableTeamScope(scope)) {
        throw this._remoteOnlyError(isSharedScope(scope) ? 'local-only-scope' : 'personal-scope', scope)
      }
      // The team store's host can also hold personal rows under the same
      // token: the row the id names there must be in
      // that team scope. A lookup that fails refuses; an absent row is left
      // to the operation, which then finds nothing.
      const target = resolveScopeTarget(scope, this.config.stores ?? [])
      const entry = target.kind === 'remote' ? target.entry : undefined
      if (entry?.url) {
        const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const serverId = this._stripForScope(id, entry.scope)
        // Tri-state: `getById` reads a 503 as null, so the
        // probe decides first. Unknown refuses; absent is left to the
        // operation, which then finds nothing; held must be a team row.
        let ownership: 'owned' | 'absent' | 'unknown' | 'assumed' = 'unknown'
        try {
          ownership = driver.probeById
            ? await driver.probeById(serverId, { signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) })
            : 'assumed'
        } catch { ownership = 'unknown' }
        if (ownership === 'unknown') throw this._remoteOnlyError('local-row', undefined, op)
        if (ownership !== 'absent') {
          let row: Engram | null = null
          try { row = await driver.getById(serverId) } catch { row = null }
          if (!row || !(this._isDeliverableTeamScope(row.scope) && isScopeWithin(row.scope, scope))) {
            throw this._remoteOnlyError('local-row', undefined, op)
          }
        }
      }
      return
    }
    const folder = this._remoteOnly.folder
    const primary = await this._basePrimaryStore.loadCached()
    const hit = primary.find(e => e.id === id)
    if (hit && !isQueuedForFolder(hit, folder)) throw this._remoteOnlyError('local-row', undefined, op)
    // Local secondary file stores are personal too: their rows answer to
    // the bare id and to the store-namespaced id.
    for (const st of this.config.stores ?? []) {
      if (st.url || !st.path) continue
      let rows: Engram[] = []
      try { rows = await new YamlPrimaryStore(st.path).loadCached() } catch { continue }
      if (rows.some(e => e.id === id || namespaceEngramId(e.id, st.scope) === id)) {
        throw this._remoteOnlyError('local-row', undefined, op)
      }
    }
  },

  _remoteOnlyRefuseLocalStore(op: string): void {
    if (this._remoteOnly) throw this._remoteOnlyError('local-store', undefined, op)
  },

  async _remoteOnlyVisible(): Promise<Engram[]> {
    if (this._remoteOnly?.blocked) return []
    // The guarded primary store shows only THIS folder's queued saves.
    const queued = await this._loadCached(this.paths.engrams)
    return [...queued, ...(await this._readCorpus())]
  },

  _queuedStaysRemote(e: Engram): RemoteOnlyWriteError {
    const ob = (e as any).structured_data?._outbox ?? {}
    return new RemoteOnlyWriteError(ob.remote_only_folder ?? 'unknown', ob.target_scope ?? e.scope, undefined, 'queued-stays-remote', e.id)
  },

  remoteOnlyFolder(): RemoteOnlyBinding | null {
    return this._remoteOnly ? { ...this._remoteOnly } : null
  },

  listFolders(): FolderEntry[] {
    return _loadFolderMap(this.paths.root).folders
  },

  setFolder(folder: string, change: FolderChange, options?: { nonce?: string; session?: string; home?: string; literal?: boolean; refuseCoveringHome?: boolean }): FolderEntry {
    this.reloadConfigIfChanged()
    const stores = this.config.stores ?? []
    const configuredScopes = stores.map(s => s.scope)
    // A remote-only entry's scope must be served by a writable url store.
    // A personal url store (`user:`) never qualifies.
    const remoteScopes = stores.filter(s => !!s.url && s.readonly !== true && this._isDeliverableTeamScope(s.scope)).map(s => s.scope)
    // The stores reach the check so a project scope is judged like write
    // routing judges it: one a server serves needs it configured, one
    // a company server withholds is refused naming the server.
    return _setFolderEntry(this.paths.root, folder, change, { configuredScopes, remoteScopes, stores, ...options })
  },

  removeFolder(folder: string, options?: { nonce?: string; session?: string }): boolean {
    return _removeFolderEntry(this.paths.root, folder, undefined, options)
  },

  issueFolderNonce(sessionId: string, folder: string, answer: FolderAnswer, options?: { home?: string; literal?: boolean; bindSession?: boolean }): string {
    return _issueFolderNonce(this.paths.root, sessionId, folder, answer, undefined, options)
  },

  endFolderNonceSession(sessionId: string): void {
    _endFolderNonceSession(this.paths.root, sessionId)
  },

  notNowFolder(folder: string, options: { nonce: string; session?: string }): void {
    _answerFolderNotNow(this.paths.root, folder, options.nonce, { ...(options.session !== undefined ? { session: options.session } : {}) })
  },

  _discoverySkippedForTempRoot(): boolean {
    if (process.env.PLUR_TEST_DISCOVER_IN_TMP === '1') return false
    return this.paths.root.startsWith(tmpdir()) || this.paths.root.startsWith('/tmp/')
  },

  _discoveryCandidates(startDir: string): Array<{ dir: string; typed: string | null; candidate: string; key: string }> {
    const out: Array<{ dir: string; typed: string | null; candidate: string; key: string }> = []
    if (this._discoverySkippedForTempRoot()) return out
    // Canonical paths: the walk sees kernel-canonical cwd spellings while
    // PLUR_PATH / $HOME are taken verbatim, so a raw string compare would miss
    // the primary under a symlinked home. Compare canonical forms; the primary is excluded here
    // and again in addStore.
    const knownPaths = new Set(
      (this.config.stores ?? []).filter(s => s.path !== undefined && !s.url).map(s => canonicalize(s.path!)),
    )
    const primaryStore = canonicalize(this.paths.engrams)
    // The user's main store is never a project store either, whichever store
    // is active: PLUR_PATH may point elsewhere while ~/.plur exists.
    const home = canonicalize(homedir())
    const mainStore = canonicalize(join(homedir(), '.plur', 'engrams.yaml'))

    // The spelling the caller typed for each real folder: an `off` entry may name the alias the user is in, and must still
    // stop discovery there. First typed ancestor wins.
    const typedFor = new Map<string, string>()
    for (let t = resolve(startDir); ; ) {
      const real = canonicalize(t)
      if (!typedFor.has(real)) typedFor.set(real, t)
      const parent = dirname(t)
      if (parent === t) break
      t = parent
    }

    // The REAL path: through a symlink into a
    // repository's sub-folder, the typed parents are outside the repository.
    let dir = canonicalize(startDir)
    const visited = new Set<string>()
    while (dir && !visited.has(dir)) {
      visited.add(dir)
      const dirKey = dir
      // Never enter the home folder or anything above it: a store
      // there is the user's own or no project's, whatever decided the folder.
      if (dirKey === home || isUnder(home, dirKey)) break
      const candidate = join(dir, '.plur', 'engrams.yaml')
      const key = canonicalize(candidate)
      if (key !== primaryStore && key !== mainStore && !knownPaths.has(key) && fs.existsSync(candidate)) {
        const typed = typedFor.get(dir)
        out.push({ dir, typed: typed !== undefined && typed !== dir ? typed : null, candidate, key })
      }
      // Stop at git root or filesystem root
      if (fs.existsSync(join(dir, '.git'))) break
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return out
  },

  _startFolderOff(startDir: string): boolean {
    const opts = { root: this.paths.root, readOnly: true }
    return _resolveFolderPolicy(resolve(startDir), opts).mode === 'off' ||
      _resolveFolderPolicy(canonicalize(startDir), opts).mode === 'off'
  },

  autoDiscoverStores(cwd?: string): Array<{ path: string; scope: string }> {
    const discovered: Array<{ path: string; scope: string }> = []
    const seen = new Set<string>()
    const startDir = cwd || process.cwd()
    // Candidates first: with no store file on the walk, the folder map is not
    // read at all (a broken map then warns only where it matters).
    const candidates = this._discoveryCandidates(startDir)
    if (candidates.length === 0 || this._startFolderOff(startDir)) return discovered
    for (const { dir, typed, candidate, key } of candidates) {
      if (seen.has(key)) continue
      // An `off` for either spelling wins.
      if (typed !== null && _resolveFolderPolicy(typed, { root: this.paths.root, readOnly: true }).mode === 'off') continue
      // A store is registered only for a folder the USER decided on itself:
      // an exact folder-map entry. On only
      // through a parent, or through a marker the repository ships, is not
      // enough — the repository's store would otherwise become a shared,
      // writable store read in every folder.
      // readOnly: discovery reads the folder map but never performs the
      // one-time trust.yaml import; that stays with the folder commands and
      // the hooks.
      if (!_hasOwnFolderDecision(dir, { root: this.paths.root, readOnly: true })) continue

      // The scope a `.plur.yaml` names is used only for a folder the user
      // trusted; an untrusted file does not choose where a
      // store's memories are filed.
      let scope = `project:${basename(dir)}`
      try {
        const plurYaml = join(dir, '.plur.yaml')
        // Read-only trust lookup: discovery never
        // performs the one-time trust.yaml import; a legacy grant still counts.
        if (fs.existsSync(plurYaml) && _isTrustedInMap(_loadFolderMap(this.paths.root, true).folders, dir)) {
          const raw = yaml.load(fs.readFileSync(plurYaml, 'utf8')) as any
          if (raw?.scope) scope = raw.scope
        }
      } catch {}

      this.addStore(candidate, scope, { shared: true, readonly: false })
      discovered.push({ path: candidate, scope })
      seen.add(key)
      logger.info(`Auto-discovered project store: ${candidate} (${scope})`)
    }
    return discovered
  },

  skippedProjectStores(cwd?: string): Array<{ path: string; folder: string }> {
    const out: Array<{ path: string; folder: string }> = []
    // Looking writes nothing: readOnly keeps a legacy
    // trust.yaml in memory instead of importing it into folders.yaml.
    const opts = { root: this.paths.root, readOnly: true }
    const startDir = cwd || process.cwd()
    const candidates = this._discoveryCandidates(startDir)
    if (candidates.length === 0 || this._startFolderOff(startDir)) return out
    for (const { dir, typed, candidate } of candidates) {
      if (typed !== null && _resolveFolderPolicy(typed, opts).mode === 'off') continue
      if (_hasOwnFolderDecision(dir, opts)) continue
      if (_resolveFolderPolicy(dir, opts).mode === 'off') continue
      out.push({ path: candidate, folder: dir })
    }
    return out
  },
}
