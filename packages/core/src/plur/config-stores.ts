import * as fs from 'fs'
import yaml from 'js-yaml'
import { dirname } from 'path'
import { writeConfigFile } from '../config-file.js'
import { loadConfig, storeEntryForDisk } from '../config.js'
import { initFilesystemStore, storePrefix } from '../engrams.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { canonicalize } from '../project-config.js'
import { containsToken, redactToken } from '../redact-token.js'
import type { PlurConfig, StoreEntry } from '../schemas/config.js'
import { mergeSensitivityForWriteback } from '../sensitivity-writeback.js'
import { PersonalScopeTakenError, registerServerEntry, SignInHeldError, type FoldReport, type ScopeHolder } from '../server-discovery.js'
import { IndexedStorage } from '../storage-indexed.js'
import { classifyStoreDuplicates, removePrimaryStoreEntries } from '../store-duplicates.js'
import { collapseExpandedStores, identityBaseOf, isSafeScopeName, isServerStoreEntry, safeOrigin, serverEntryIdentities } from '../store-expand.js'
import { normalizeEndpointUrl, RemoteStore } from '../store/remote-store.js'
import { withLock } from '../file-lock.js'
import { REFUSED_CREDENTIAL_WRITE } from '../atomic-write.js'
import { AddRemoteStoreError, isFromServerEntry, serverEntryIdOf, serverEntryScopeRefusal, stringList } from './helpers.js'

export interface ConfigStoresMethods {
  /**
   * Register an additional engram store (addStore): a filesystem path, or a
   * remote store via `options.url` + `options.token` (first arg unused).
   * Dedup: REMOTE by url + scope; LOCAL by path only (two entries on one file
   * would double-load global engrams). Returns `added`, `already_registered`
   * (`scope` is the EXISTING entry's) or `overwritten` (via overwriteScope).
   */
  /** mtime (ms) of config.yaml, or 0 if it cannot be stat'd. */
  /** @internal */
  statConfigMtime(): number

  /**
   * Load config.yaml for in-memory use, dropping a LOCAL store entry (by
   * canonical path) only when its file is the primary store, or its file AND
   * scope repeat an earlier entry — either would load engrams twice.
   * One file under two different scopes keeps both (each admits different
   * engrams) with an informational warning. Drops are in memory only; config.yaml
   * is never rewritten here. `ignoredDuplicateStores()` reports them.
   */
  /** @internal */
  _loadConfig(): PlurConfig

  /** Local store entries in config.yaml that are ignored because they name the
   *  primary file, or repeat an earlier entry's file and scope. */
  ignoredDuplicateStores(): StoreEntry[]

  /**
   * Remove the config.yaml store entries that name the primary engrams file
   * (`plur stores prune`). They are already ignored at load; this stops
   * the warning for good. Only those entries are removed and the rest of
   * config.yaml is kept byte for byte — see {@link removePrimaryStoreEntries}.
   * Returns the removed entries.
   */
  removeDuplicatePrimaryStores(): StoreEntry[]

  /**
   * Reload this.config if config.yaml's mtime changed since the last load, so
   * the long-lived MCP instance sees stores added by hand or by another process
   * without a restart. Store operations call this first; costs one statSync.
   * @returns true if the config was reloaded.
   */
  /** @internal */
  reloadConfigIfChanged(): boolean

  /** Persist a new stores list to config.yaml, preserving other keys, then
   *  refresh the in-memory config + mtime. `serverSensitivityScopes` is passed
   *  by persistScopeMetadata (see {@link mergeStoresForWriteback}).
   *  The read-merge-write runs under {@link withLock} on config.yaml so
   *  concurrent writers cannot lose each other's change; the in-memory refresh
   *  happens after release. */
  /** @internal */
  persistStores(stores: StoreEntry[], opts?: {
    serverSensitivityScopes?: Set<string>
    onConfigWrite?: (before: string | null, after: string) => void
    /** A new key for a server entry: written in place onto the one
     *  on-disk server entry `entry` was expanded from, found by identity on
     *  the fresh read under the lock. No match, or more than one, is refused
     *  and nothing is written. The collapse step never writes a token. */
    serverEntryToken?: { entry: StoreEntry; token: string; tokenEnv?: string }
  }): void

  /**
   * MERGE typed `stores` onto the RAW YAML entries so a writeback never strips
   * unknown fields: unknown top-level keys, and unknown keys nested in
   * `sensitivity` (one-level deep merge; a shallow spread would lose them).
   * Parsed deltas land on top of raw values.
   * `serverSensitivityScopes`: scopes whose typed `sensitivity.forbid` was just
   * synced from `/me` and must win over the raw-forbid restore; other callers
   * omit it.
   */
  /** @internal */
  mergeStoresForWriteback(rawStores: unknown, stores: StoreEntry[], serverSensitivityScopes?: Set<string>): StoreEntry[]

  addStore(storePath: string, scope: string, options?: {
      shared?: boolean; readonly?: boolean; url?: string; token?: string; overwriteScope?: boolean
      /** The environment variable `token` was read from. The entry then
       *  stores `token_env: <name>` and never the token itself. */
      tokenEnv?: string
    }): {
    status: 'added' | 'already_registered' | 'overwritten' | 'token_rotated'; scope: string
    /** On `token_rotated` for a scope of a server entry: every scope
     *  the new token now serves. The key is shared by all of them. */
    token_scopes?: string[]
  }

  /**
   * Register a company server as ONE store entry (keyed by
   * {@link normalizeEndpointUrl}); a new entry takes `personalScope` as its
   * compat `scope`, a new key updates the entry in place keeping its scope settings.
   * - Same-key per-scope entries fold in ({@link foldStoresIntoServerEntry});
   *   others go to `kept_separate`. Two server entries for the url are refused;
   *   taking the personal scope throws {@link PersonalScopeTakenError} unless `removeStale`.
   * - No network call; atomic write under the config lock, only on change.
   * - No key reaches the result, an error or the log (`tokenEnv` stores only the name).
   */
  registerEnterpriseServer(url: string, opts: {
    token?: string; tokenEnv?: string; personalScope: string; enterprise?: Record<string, string>; removeStale?: boolean
    migrateLegacyPersonal?: boolean
    /** Required for a legacy conversion; verifies its backup under this lock. */
    beforeLegacyMigration?: (configPath: string) => void
    /** Installer rollback evidence, delivered under the write lock. Contains secrets; never log. */
    onConfigWrite?: (before: string | null, after: string) => void
    /** Refuse ({@link SignInHeldError}) when config.yaml already holds a sign-in for the url. */
    keepSignIn?: boolean
    /** Called under the config lock with config.yaml's path, before a write
     *  that removes stale entries (the file is still as read); a throw writes
     *  nothing. `plur login --remove-stale` backs config.yaml up here. */
    beforeRemove?: (configPath: string) => void
  }): Promise<{ status: 'added' | 'updated' | 'unchanged'; fold: FoldReport; removed: ScopeHolder[]; migratedLegacy?: boolean }>

  /**
   * Register a remote store only after the server vouches for it: validate the
   * URL, call `GET /api/v1/me` with the token (raced against `timeoutMs`),
   * require `scope` among the authorised scopes, THEN delegate to `addStore`.
   * Any refusal throws {@link AddRemoteStoreError} without touching config.yaml.
   * Re-runs return `already_registered`; a new accepted token returns
   * `token_rotated`; a rejected token leaves the old entry intact.
   * The token is scrubbed from every thrown message (the /me error carries an
   * untrusted response body).
   */
  addRemoteStore(opts: {
    url: string; token: string; scope: string
    /** The environment variable `token` was read from: only its name is stored. */
    tokenEnv?: string
    shared?: boolean; readonly?: boolean; timeoutMs?: number
    /** Replace an entry that already holds `scope` for a DIFFERENT store.
     *  Never implied: without it such a conflict is refused (code
     *  `scope_conflict`). Applied only after /me has verified the token. */
    overwriteScope?: boolean
  }): Promise<{ status: 'added' | 'already_registered' | 'token_rotated' | 'overwritten'; scope: string; username?: string; authorised: string[]; token_scopes?: string[] }>

  /**
   * Every check {@link addRemoteStore} makes, and no write: the URL,
   * the token against `/me`, `scope` among the authorised scopes, and no
   * other store already holding `scope` (unless `overwriteScope`). Throws the
   * same {@link AddRemoteStoreError}s. `plur remote --scopes a,b` runs it for
   * every scope first, so one refused scope leaves config.yaml untouched.
   */
  verifyRemoteStore(opts: {
    url: string; token: string; scope: string; timeoutMs?: number; overwriteScope?: boolean
  }): Promise<{ scope: string; username?: string; authorised: string[] }>

  /**
   * Materialize a filesystem store file if absent — the existsSync→write
   * sequence runs under the store's own `<path>.lock` file so it cannot race
   * a concurrent writer or a second registration and clobber their content
   * (store-write convention; see `_withStoreLock`). `addStore` is sync and
   * reachable from the constructor via `autoDiscoverStores`, so this takes
   * the SAME lock file via the sync `withLock` rather than the async
   * `_withStoreLock`. Parent dirs are created up front — the lock file lives
   * next to the store file.
   */
  /** @internal */
  _materializeLocalStore(storePath: string): void
}

export const configStoresMethods: ConfigStoresMethods & ThisType<Plur> = {
  statConfigMtime(): number {
    try { return fs.statSync(this.paths.config).mtimeMs } catch { return 0 }
  },

  _loadConfig(): PlurConfig {
    const config = loadConfig(this.paths.config)
    const stores = config.stores ?? []
    // Two different scopes behind one id prefix: said once at load, and every
    // action by a namespaced id for them is refused.
    {
      const byPrefix = new Map<string, Set<string>>()
      for (const s of stores) {
        if (typeof s.scope !== 'string') continue
        const p = storePrefix(s.scope)
        byPrefix.set(p, (byPrefix.get(p) ?? new Set()).add(s.scope))
      }
      for (const [p, scopes] of byPrefix) {
        if (scopes.size < 2) continue
        const key = `prefix\0${p}`
        if (this._warnedDuplicateStores.has(key)) continue
        this._warnedDuplicateStores.add(key)
        logger.warning(`[plur:config] stores ${[...scopes].map(x => `"${x}"`).join(' and ')} share the engram id prefix ${p}. `
          + `Forget, feedback, pin and update by an id with that prefix are refused for them; pass the store's scope instead.`)
      }
    }
    if (!stores.some(s => s.path !== undefined && !s.url)) {
      this._ignoredDuplicates = []
      return config
    }
    const { kept, ignored, sharedFile } = classifyStoreDuplicates(stores, this.paths.engrams)
    const warnOnce = (key: string, message: string): void => {
      if (this._warnedDuplicateStores.has(key)) return
      this._warnedDuplicateStores.add(key)
      logger.warning(message)
    }
    for (const { entry: s, primary } of ignored) {
      warnOnce(`${s.path}\0${s.scope}`, primary
        ? `[plur:config] ignoring store "${s.scope}" (${s.path}): it is the primary store file, which is always loaded. ` +
          `Loading it again would inject every engram in it twice. The entry is left in config.yaml; run \`plur stores prune\` to remove it.`
        : `[plur:config] ignoring store "${s.scope}" (${s.path}): the same file is already registered under the same scope. ` +
          `Loading it again would inject its engrams twice. The entry is left in config.yaml; remove it to silence this warning.`)
    }
    for (const { entry: s, firstScope } of sharedFile) {
      warnOnce(`${s.path}\0${s.scope}`,
        `[plur:config] store "${s.scope}" (${s.path}) is the same file as store "${firstScope}". Both are loaded: ` +
        `each scope admits its own engrams, and engrams scoped "global" in that file appear under both.`)
    }
    this._ignoredDuplicates = ignored
    return ignored.length ? { ...config, stores: kept } : config
  },

  ignoredDuplicateStores(): StoreEntry[] {
    return this._ignoredDuplicates.map(d => d.entry)
  },

  removeDuplicatePrimaryStores(): StoreEntry[] {
    const removed = removePrimaryStoreEntries(this.paths.config, this.paths.engrams)
    if (removed.length) {
      this.config = this._loadConfig()
      this.configMtimeMs = this.statConfigMtime()
    }
    return removed
  },

  reloadConfigIfChanged(): boolean {
    const mtime = this.statConfigMtime()
    if (mtime === 0 || mtime === this.configMtimeMs) return false
    this.config = this._loadConfig()
    this.configMtimeMs = mtime
    // `config.index` is `undefined` on a default install (the `.partial()`
    // schema neutralises its default, as in the constructor), so a bare truthy
    // check would skip the refresh this method exists for (a store added by
    // editing config.yaml out of process) on default installs that do have an
    // index. Refresh whenever an index is actually active, or config asks for one.
    if (this.indexedStorage !== null || this.config.index) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    logger.info('[plur] Reloaded config.yaml (changed on disk since last load)')
    return true
  },

  persistStores(stores: StoreEntry[], opts?: {
    serverSensitivityScopes?: Set<string>
    onConfigWrite?: (before: string | null, after: string) => void
    /** A new key for a server entry: written in place onto the one
     *  on-disk server entry `entry` was expanded from, found by identity on
     *  the fresh read under the lock. No match, or more than one, is refused
     *  and nothing is written. The collapse step never writes a token. */
    serverEntryToken?: { entry: StoreEntry; token: string; tokenEnv?: string }
  }): void {
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      let before: string | null = null
      // Read the existing config to preserve other top-level keys (auto_learn,
      // packs, embeddings, routing defaults, …). A TRANSIENT read failure on an
      // EXISTING file (EACCES, a concurrent truncating writer, a momentary FS
      // error) must NOT be swallowed: proceeding from `{}` would write a
      // stores-only file and silently drop every other top-level setting. Only an
      // ENOENT (the config genuinely doesn't exist yet) is safe to start from `{}`;
      // any other error aborts the writeback so we never truncate a live config.
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        before = raw
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      // A `token_env` entry keeps its reference and never the token it was
      // resolved to at load: the typed entries carry that value.
      //
      // Collapse expanded per-scope entries back into their server entry:
      // N in-memory entries with one EXPANDED_FROM identity → the one entry on
      // disk with that identity, wherever it sits now. Positions are never
      // trusted: another process may have inserted or reordered entries since
      // these were loaded.
      const rawArray = Array.isArray(configData.stores) ? (configData.stores as unknown[]) : []
      const ids = serverEntryIdentities(rawArray)
      const indexById = new Map<string, number>()
      ids.forEach((id, i) => { if (id !== undefined) indexById.set(id, i) })
      const collapsedRaw = collapseExpandedStores(stores, rawArray, opts?.serverSensitivityScopes)
      const rekey = opts?.serverEntryToken
      if (rekey) {
        // Only the selected entry, validated here under the lock: same
        // identity, exactly one on disk. Another entry on the same url keeps
        // its own token and token_env.
        const base = identityBaseOf(serverEntryIdOf(rekey.entry) ?? '#')
        const matches = ids.flatMap((id, i) => (id !== undefined && identityBaseOf(id) === base ? [i] : []))
        if (matches.length !== 1) {
          throw new Error(`addStore: ${matches.length
            ? `more than one server entry for ${safeOrigin(rekey.entry.url!)} has the same url and scopes, so which key to replace is ambiguous`
            : `the server entry for ${safeOrigin(rekey.entry.url!)} changed on disk since it was loaded`}. Nothing was changed.`)
        }
        const i = matches[0]
        // Spread keeps every key where it was; storeEntryForDisk drops an
        // undefined token_env and a token that only repeats its variable.
        collapsedRaw[i] = { ...(collapsedRaw[i] as Record<string, unknown>), token: rekey.token, token_env: rekey.tokenEnv }
      }
      // Per-scope entries merge onto per-scope raw entries only: a server entry
      // shares url+scope with its compat `scope`, so letting it be a merge target
      // would turn an older per-scope entry for that scope into a second server entry.
      const merged = this.mergeStoresForWriteback(
        collapsedRaw.filter(r => !isServerStoreEntry(r)),
        stores.filter(s => !isFromServerEntry(s)),
        opts?.serverSensitivityScopes,
      )
      // Write in the in-memory order, which is the on-disk order: each server
      // entry takes the place of the first entry expanded from it.
      const out: unknown[] = []
      const emitted = new Set<number>()
      let next = 0
      for (const s of stores) {
        if (!isFromServerEntry(s)) { out.push(merged[next++]); continue }
        const idx = indexById.get(serverEntryIdOf(s)!)
        // No raw entry with this identity: it changed or went away since load.
        // Nothing of ours is written for it; the raw entry is kept below.
        if (idx !== undefined && !emitted.has(idx)) {
          emitted.add(idx)
          out.push(collapsedRaw[idx])
        }
      }
      // A server entry with no in-memory entry (an empty `scopes`, rejected at
      // load, or written by another process since) is kept, near its place.
      collapsedRaw.forEach((r, i) => {
        if (isServerStoreEntry(r) && !emitted.has(i)) out.splice(Math.min(i, out.length), 0, r)
      })
      configData.stores = (out as StoreEntry[])
        .map(e => storeEntryForDisk(e as unknown as Record<string, unknown>) as unknown as StoreEntry)
      // Atomic + fsynced. A plain writeFileSync truncates in place, and
      // loadConfig turns a parse failure into DEFAULT config — so a crash
      // mid-write would silently erase store registrations and route later
      // writes to the local default store. atomicWrite is tmp + fsync +
      // rename, so a crash leaves the previous complete config.
      const after = yaml.dump(configData, { lineWidth: 120, noRefs: true })
      writeConfigFile(this.paths.config, after)
      opts?.onConfigWrite?.(before, after)
    })
    this.config = this._loadConfig()
    this.configMtimeMs = this.statConfigMtime()
  },

  mergeStoresForWriteback(rawStores: unknown, stores: StoreEntry[], serverSensitivityScopes?: Set<string>): StoreEntry[] {
    if (!Array.isArray(rawStores)) return stores
    // Key on url+scope (remote) or path+scope (local); never url alone — one
    // enterprise URL hosts many scopes (addStore dedup identity is url+scope).
    const keyOf = (e: { url?: unknown; path?: unknown; scope?: unknown }): string | null => {
      const scope = typeof e?.scope === 'string' ? e.scope : ''
      if (typeof e?.url === 'string') return `${e.url}\0${scope}`
      if (typeof e?.path === 'string') return `${e.path}\0${scope}`
      return null
    }
    const rawMap = new Map<string, Record<string, unknown>>()
    for (const r of rawStores as unknown[]) {
      const k = keyOf(r as Record<string, unknown>)
      if (k) rawMap.set(k, r as Record<string, unknown>)
    }
    return stores.map((typed) => {
      const k = keyOf(typed)
      const raw = k ? rawMap.get(k) : undefined
      if (!raw) {
        // No raw match (genuinely new entry, e.g. an addStore append) — or an
        // entry with neither url nor path (hand-edited; refine prevents at write
        // time). Use the typed entry as-is rather than dropping it.
        if (!k) logger.warning(`[plur:persistStores] store entry for scope "${typed.scope}" has neither url nor path — writing typed entry as-is`)
        return typed
      }
      // Raw config is unvalidated YAML, so `sensitivity` may be any value; it is
      // merged only when it is a plain object.
      // `forbid` is normalized at read time, so when raw carried one it is
      // restored verbatim, or the first writeback would erase a forward-compat
      // declaration. Exception: scopes in `serverSensitivityScopes` (synced from
      // `/me` by persistScopeMetadata) take the typed `forbid`, or the server
      // policy is discarded and config.yaml is rewritten on every session_start.
      // collapseExpandedStores applies the same rule to scope_settings.
      const mergedSensitivity = mergeSensitivityForWriteback(
        (raw as { sensitivity?: unknown }).sensitivity,
        typed.sensitivity,
        serverSensitivityScopes?.has(typed.scope) === true,
      )
      const merged: Record<string, unknown> = {
        ...raw,
        ...typed,
        // One-level deep-merge of `sensitivity`: parsed deltas over raw nested
        // unknowns. Without this explicit merge a shallow `...typed` would
        // replace `sensitivity` wholesale and lose nested unknowns.
        sensitivity: mergedSensitivity,
      }
      if (merged.sensitivity === undefined) delete merged.sensitivity
      return merged as StoreEntry
    })
  },

  addStore(storePath: string, scope: string, options?: {
      shared?: boolean; readonly?: boolean; url?: string; token?: string; overwriteScope?: boolean
      /** The environment variable `token` was read from. The entry then
       *  stores `token_env: <name>` and never the token itself. */
      tokenEnv?: string
    }): {
    status: 'added' | 'already_registered' | 'overwritten' | 'token_rotated'; scope: string
    /** On `token_rotated` for a scope of a server entry: every scope
     *  the new token now serves. The key is shared by all of them. */
    token_scopes?: string[]
  } {
    const isRemote = Boolean(options?.url)

    // Validation gate: catch malformed URLs and duplicate scopes at
    // registration time instead of silently failing on first use.
    if (isRemote) {
      const url = options!.url!
      // Permissive URL check — must parse, must be http(s).
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`addStore: invalid URL "${url}" — must be a valid http(s) URL`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`addStore: URL "${url}" has unsupported protocol "${parsed.protocol}" — must be http(s)`)
      }
    } else {
      if (!storePath || typeof storePath !== 'string') {
        throw new Error(`addStore: storePath must be a non-empty string, got ${typeof storePath}`)
      }
    }
    if (!scope || typeof scope !== 'string') {
      throw new Error(`addStore: scope must be a non-empty string, got ${typeof scope}`)
    }

    // Pick up any out-of-process config edit before we dedup/write.
    this.reloadConfigIfChanged()
    const config = loadConfig(this.paths.config)

    // Dedup identity:
    // - REMOTE: normalized url + scope (`https://x.com`, `.../` and `.../sse` are
    //   one server; the stored spelling is never rewritten).
    // - LOCAL: canonical path only (symlinks, /var vs /private/var); a second
    //   scope on one file would double-load global engrams.
    // - The primary engrams.yaml is never a secondary store under any spelling.
    const canonicalStorePath = isRemote ? '' : canonicalize(storePath)
    if (!isRemote && canonicalStorePath === canonicalize(this.paths.engrams)) {
      const ignoredHere = this._ignoredDuplicates
        .filter(d => d.duplicateOf === 'the primary store')
        .map(d => `"${d.entry.scope}" (${d.entry.path})`)
      throw new Error(
        `addStore: "${storePath}" is the primary store (${this.paths.engrams}); it is always loaded and cannot be registered again as "${scope}".` +
        (ignoredHere.length
          ? ` config.yaml already lists it as ${ignoredHere.join(', ')}; that entry is ignored at load. Run \`plur stores prune\` to remove it.`
          : ''),
      )
    }
    // Local stores answer from what is LOADED (this.config, which drops
    // ignored duplicates), not the raw file: an entry that is ignored at load
    // must never be reported as the registration that covers this path. Among
    // loaded entries for the same file, one with the requested scope wins.
    const localMatches = isRemote ? [] : (this.config.stores ?? []).filter(s =>
      s.path !== undefined && !s.url && (s.path === storePath || canonicalize(s.path) === canonicalStorePath))
    const sameEntry = isRemote
      ? config.stores?.find(s => s.url !== undefined && normalizeEndpointUrl(s.url) === normalizeEndpointUrl(options!.url!) && s.scope === scope)
      : (localMatches.find(s => s.scope === scope) ?? localMatches[0])
    if (sameEntry) {
      // Token rotation: a matched remote endpoint with a NEW token means the
      // server-side token was rotated/expired and the caller is re-supplying
      // it, so update the token in place rather than keep the stale one.
      // The same token now read from a variable (or no longer) is a change of
      // what config.yaml holds, so it is written like a rotation.
      const tokenEnv = options?.tokenEnv || undefined
      const refChanged = isRemote && options?.token !== undefined && tokenEnv !== (sameEntry.token_env || undefined)
      if (isRemote && options?.token !== undefined && (options.token !== sameEntry.token || refChanged)) {
        // A scope of a server entry: the key is one per server, so the
        // new token goes onto that entry and serves every scope it lists.
        // Only that one entry: another server entry on the same url may hold
        // a different key for other scopes. A scope two server entries on this
        // url both list does not say which key to replace: refused.
        if (isFromServerEntry(sameEntry)) {
          const id = serverEntryIdOf(sameEntry)
          const listing = new Set((config.stores ?? [])
            .filter(s => isFromServerEntry(s) && s.scope === sameEntry.scope && normalizeEndpointUrl(s.url!) === normalizeEndpointUrl(sameEntry.url!))
            .map(serverEntryIdOf))
          if (listing.size > 1) {
            throw new Error(`addStore: scope "${sameEntry.scope}" is listed by more than one server entry for ${safeOrigin(sameEntry.url!)}, ` +
              `so which entry's key to replace is ambiguous. Nothing was changed. Remove the duplicate from config.yaml or re-run the enterprise setup.`)
          }
          this.persistStores(config.stores ?? [], { serverEntryToken: { entry: sameEntry, token: options.token, tokenEnv } })
          const token_scopes = (config.stores ?? []).filter(s => serverEntryIdOf(s) === id).map(s => s.scope)
          logger.info(`[plur:addStore] rotated the server key for ${safeOrigin(sameEntry.url!)} (${token_scopes.length} scope(s))`)
          return { status: 'token_rotated', scope: sameEntry.scope, token_scopes }
        }
        const rotated = (config.stores ?? []).map(s =>
          s === sameEntry ? { ...s, token: options.token, token_env: tokenEnv } : s,
        )
        this.persistStores(rotated)
        logger.info(`[plur:addStore] rotated token for ${safeOrigin(options.url ?? "")} (scope "${sameEntry.scope}")`)
        return { status: 'token_rotated', scope: sameEntry.scope }
      }
      // A local store can have a config entry while its file is absent;
      // re-running stores_add with the same path is the natural repair, so the
      // idempotent re-add runs the same init (and the MCP "Store initialized"
      // note is truthful on this path too). Idempotent and cheap when the file
      // exists.
      if (!isRemote) this._materializeLocalStore(storePath)
      return { status: 'already_registered', scope: sameEntry.scope }
    }

    // Different endpoint, same scope: forbid by default to prevent
    // silent ambiguity ("which store does scope X belong to?"). Override
    // with options.overwriteScope=true to replace the existing entry.
    const scopeConflict = config.stores?.find(s => s.scope === scope)
    if (scopeConflict) {
      // One scope of a server entry cannot be replaced or removed on its own:
      // the entry lists its scopes together, and dropping the expanded entry
      // would leave it on disk while reporting success.
      if (isFromServerEntry(scopeConflict)) throw new Error(`addStore: ${serverEntryScopeRefusal(scope, scopeConflict.url!)}`)
      if (options?.overwriteScope !== true) {
        const existingId = scopeConflict.url ?? scopeConflict.path
        throw new Error(
          `addStore: scope "${scope}" is already registered to a different store (${existingId}). ` +
          `Pass overwriteScope: true to replace, or pick a unique scope.`,
        )
      }
      // Caller opted in — drop the conflicting entry before appending.
      logger.warning(`[plur:addStore] overwriting scope "${scope}" (was: ${scopeConflict.url ?? scopeConflict.path})`)
    }

    const newEntry: StoreEntry = isRemote
      ? {
          url:      options!.url!,
          token:    options!.token,
          ...(options?.tokenEnv ? { token_env: options.tokenEnv } : {}),
          scope,
          shared:   options?.shared   ?? true,    // remote stores are shared by definition
          readonly: options?.readonly ?? false,
        }
      : {
          path:     storePath,
          scope,
          shared:   options?.shared   ?? false,
          readonly: options?.readonly ?? false,
        }
    // Filesystem stores: initialize the file now so the path materializes
    // immediately. Fail loudly if the path is unwritable — better than
    // silently landing writes in the primary store when the file never
    // exists.
    if (!isRemote) this._materializeLocalStore(storePath)

    const stores = scopeConflict
      ? [...(config.stores ?? []).filter(s => s.scope !== scope), newEntry]
      : [...(config.stores ?? []), newEntry]
    this.persistStores(stores)
    return { status: scopeConflict ? 'overwritten' : 'added', scope }
  },

  async registerEnterpriseServer(url: string, opts: {
    token?: string; tokenEnv?: string; personalScope: string; enterprise?: Record<string, string>; removeStale?: boolean
    migrateLegacyPersonal?: boolean
    /** Required for a legacy conversion; verifies its backup under this lock. */
    beforeLegacyMigration?: (configPath: string) => void
    /** Installer rollback evidence, delivered under the write lock. Contains secrets; never log. */
    onConfigWrite?: (before: string | null, after: string) => void
    /** Refuse ({@link SignInHeldError}) when config.yaml already holds a sign-in for the url. */
    keepSignIn?: boolean
    /** Called under the config lock with config.yaml's path, before a write
     *  that removes stale entries (the file is still as read); a throw writes
     *  nothing. `plur login --remove-stale` backs config.yaml up here. */
    beforeRemove?: (configPath: string) => void
  }): Promise<{ status: 'added' | 'updated' | 'unchanged'; fold: FoldReport; removed: ScopeHolder[]; migratedLegacy?: boolean }> {
    let parsed: URL
    try { parsed = new URL(url) } catch {
      throw new Error('registerEnterpriseServer: the server address is not a valid http(s) URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`registerEnterpriseServer: the server address must be http(s), not ${parsed.protocol}`)
    }
    if (parsed.username || parsed.password) {
      // A key in the address would be written to config.yaml and shown in logs.
      throw new Error(`registerEnterpriseServer: the server address for ${safeOrigin(url)} carries a user name or password; pass the key as token or tokenEnv instead`)
    }
    const tokenEnv = opts?.tokenEnv || undefined
    if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
      throw new Error('registerEnterpriseServer: tokenEnv must be an environment variable name')
    }
    if (!tokenEnv && (typeof opts?.token !== 'string' || opts.token === '')) {
      throw new Error(`registerEnterpriseServer: no key was given for ${safeOrigin(url)} (token or tokenEnv)`)
    }
    const personal = opts?.personalScope
    if (typeof personal !== 'string' || !/^user:[^:/\s]+:[^:/\s]+$/.test(personal) || !isSafeScopeName(personal)) {
      throw new Error('registerEnterpriseServer: personalScope must be the personal scope (user:<org>:<username>) the server named')
    }

    // Read the outbox first: a failure here must not follow a written key.
    const outbox = await this.listOutbox()
    let result: ReturnType<typeof registerServerEntry> | undefined
    try {
      this._updateRawStores(rawStores => {
        try {
          result = registerServerEntry(rawStores, { url, token: tokenEnv ? undefined : opts.token, tokenEnv, personalScope: personal, enterprise: opts.enterprise, removeStale: opts.removeStale === true, keepSignIn: opts.keepSignIn === true, migrateLegacyPersonal: opts.migrateLegacyPersonal === true })
          if (result.migratedLegacy) {
            if (!opts.beforeLegacyMigration) throw new Error('legacy migration requires a verified configuration backup')
            opts.beforeLegacyMigration(this.paths.config)
          }
        } catch (err) {
          if (err instanceof SignInHeldError) throw new SignInHeldError(`registerEnterpriseServer: ${err.message}`)
          // The refusal keeps its type and the entries it names, so
          // `plur login` can name them and offer to remove them.
          if (err instanceof PersonalScopeTakenError) {
            throw new PersonalScopeTakenError(`registerEnterpriseServer: ${err.message}`, err.personalScope, err.holders, err.removable)
          }
          throw new Error(`registerEnterpriseServer: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (result.status === 'unchanged') return false
        if (result.removed.length && opts.beforeRemove) {
          try { opts.beforeRemove(this.paths.config) } catch (err) {
            throw new Error(`registerEnterpriseServer: the backup of config.yaml before removing the stale ${result.removed.length === 1 ? 'entry' : 'entries'} could not be made (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`)
          }
        }
        // The key is written by _updateRawStores through writeConfigFile, under
        // this lock: owner-only on POSIX (tightened before the write) and on
        // Windows (a verified access list, or the write is refused).
        rawStores.splice(0, rawStores.length, ...result.stores)
        return true
      }, opts.onConfigWrite)
    } catch (err) {
      const e = err as { message?: unknown; name?: unknown; mark?: { line?: unknown }; code?: unknown }
      if (typeof e?.message === 'string' && e.message.startsWith('registerEnterpriseServer: ')) throw err
      // A refused credential write (owner-only protection) keeps its cause and the
      // opt-out; its text is fixed wording plus icacls details, never the key.
      if (typeof e?.message === 'string' && e.message.startsWith(REFUSED_CREDENTIAL_WRITE)) {
        throw new Error(`registerEnterpriseServer: ${e.message.slice('atomicWrite: '.length)}`)
      }
      // A YAML error quotes the lines around the fault, and its reason can
      // name an alias or tag from the file; either can hold a key. Name the
      // line number only.
      if (e?.name === 'YAMLException') {
        const line = typeof e.mark?.line === 'number' ? ` at line ${e.mark.line + 1}` : ''
        throw new Error(`registerEnterpriseServer: config.yaml is not valid YAML${line}. Nothing was changed.`)
      }
      throw new Error(`registerEnterpriseServer: config.yaml could not be updated${typeof e?.code === 'string' ? ` (${e.code})` : ''}. Nothing was changed.`)
    }
    const r = result!
    const served = new Set<string>([
      ...(typeof r.entry.scope === 'string' ? [r.entry.scope] : []),
      ...stringList(r.entry.scopes), ...stringList(r.entry.pinned_scopes),
    ])
    const counts = new Map<string, number>()
    for (const row of outbox) {
      if (served.has(row.target_scope)) counts.set(row.target_scope, (counts.get(row.target_scope) ?? 0) + 1)
    }
    const queued_by_scope: Record<string, number> = Object.fromEntries(counts)
    logger.info(`[plur:register] ${r.status} the server entry for ${safeOrigin(url)}: ${r.report.folded.length} folded, ${r.report.kept_separate.length} kept separate${r.removed.length ? `, ${r.removed.length} stale removed` : ''}`)
    return { status: r.status, fold: { ...r.report, queued_by_scope }, removed: r.removed, ...(r.migratedLegacy ? { migratedLegacy: true } : {}) }
  },

  async addRemoteStore(opts: {
    url: string; token: string; scope: string
    /** The environment variable `token` was read from: only its name is stored. */
    tokenEnv?: string
    shared?: boolean; readonly?: boolean; timeoutMs?: number
    /** Replace an entry that already holds `scope` for a DIFFERENT store.
     *  Never implied: without it such a conflict is refused (code
     *  `scope_conflict`). Applied only after /me has verified the token. */
    overwriteScope?: boolean
  }): Promise<{ status: 'added' | 'already_registered' | 'token_rotated' | 'overwritten'; scope: string; username?: string; authorised: string[]; token_scopes?: string[] }> {
    const { username, authorised } = await this.verifyRemoteStore(opts)
    const { url, token, scope } = opts
    const { status, token_scopes } = this.addStore('', scope, {
      url, token, shared: opts.shared, readonly: opts.readonly,
      ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : {}),
      ...(opts.overwriteScope === true ? { overwriteScope: true } : {}),
    })
    return { status, scope, ...(username ? { username } : {}), authorised, ...(token_scopes ? { token_scopes } : {}) }
  },

  async verifyRemoteStore(opts: {
    url: string; token: string; scope: string; timeoutMs?: number; overwriteScope?: boolean
  }): Promise<{ scope: string; username?: string; authorised: string[] }> {
    const { url, token, scope } = opts
    const timeoutMs = opts.timeoutMs ?? 5000
    // Every encoding of the token, not only the exact string.
    const scrub = (msg: string) => redactToken(msg, token)
    let parsed: URL | undefined
    try { parsed = new URL(url) } catch { /* handled below */ }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new AddRemoteStoreError('invalid_url', `invalid URL "${scrub(String(url))}" — must be a valid http(s) URL`)
    }
    if (!token) throw new AddRemoteStoreError('missing_token', 'a token is required to register a remote store')
    if (!scope) throw new AddRemoteStoreError('missing_scope', 'a scope is required to register a remote store')

    // A throwaway driver, not _getRemoteDriver: an unverified token must not
    // be cached as this url's driver.
    const driver = new RemoteStore(url, token, scope)
    let me: Awaited<ReturnType<RemoteStore['me']>>
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      me = await Promise.race([
        driver.me().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`/me timeout (${timeoutMs}ms)`)), timeoutMs)
        }),
      ])
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : String(err))
      if (/\b40[13]\b/.test(msg)) {
        throw new AddRemoteStoreError('auth_rejected', `the server at ${url} rejected the token (${msg})`)
      }
      throw new AddRemoteStoreError('unreachable', `could not verify the token against ${url}: ${msg}`)
    }
    // The /me answer is the server's, not ours: re-apply the strict scope
    // grammar and drop any scope that carries the token in any encoding, so a
    // buggy or hostile server cannot get the token printed through the
    // `authorised` list or the username.
    const authorised = me.scopes.filter(s =>
      typeof s === 'string' && s.length <= 256 && /^[\w:./-]+$/.test(s) && !containsToken(s, token))
    const withheld = me.scopes.length - authorised.length
    const username = me.username && !containsToken(me.username, token) ? me.username : undefined
    if (!authorised.includes(scope)) {
      throw new AddRemoteStoreError(
        'scope_not_authorised',
        `the token is not authorised for scope "${scope}" on ${url}. ` +
        `Authorised: ${authorised.length ? authorised.join(', ') : '(none)'}` +
        (withheld ? ` (${withheld} withheld: malformed or carrying the token)` : ''),
        authorised,
      )
    }
    // Scope held by a different store: refuse here, as a typed error, unless
    // the caller asked to replace it. Mirrors addStore's identity rule (a
    // normalized url+scope match is the SAME entry, not a conflict).
    {
      this.reloadConfigIfChanged()
      const stores = loadConfig(this.paths.config).stores ?? []
      const same = stores.some(s => s.url !== undefined && s.scope === scope &&
        normalizeEndpointUrl(s.url) === normalizeEndpointUrl(url))
      const other = same ? undefined : stores.find(s => s.scope === scope)
      // overwriteScope never reaches a scope of a server entry.
      if (other && isFromServerEntry(other)) {
        throw new AddRemoteStoreError('scope_conflict', serverEntryScopeRefusal(scope, other.url!), authorised)
      }
      if (other && opts.overwriteScope !== true) {
        throw new AddRemoteStoreError(
          'scope_conflict',
          `scope "${scope}" is already registered to a different store (${scrub(String(other.url ?? other.path))}). ` +
          `Nothing was changed; pass overwriteScope to replace that entry.`,
          authorised,
        )
      }
    }
    return { scope, ...(username ? { username } : {}), authorised }
  },

  _materializeLocalStore(storePath: string): void {
    try {
      const dir = dirname(storePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      withLock(storePath, () => {
        if (!fs.existsSync(storePath)) initFilesystemStore(storePath)
      })
    } catch (err) {
      throw new Error(
        `addStore: cannot initialize store at "${storePath}": ${(err as Error).message}`,
      )
    }
  },
}
