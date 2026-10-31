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
   * Register an additional engram store.
   *
   * Two shapes — exactly one of `pathOrUrl` semantics applies:
   *   - filesystem (default): pass a path. `options.url` undefined.
   *   - remote (PLUR Enterprise / any compatible REST API):
   *     pass any string for the first arg (it goes into a slot we
   *     never read), set `options.url` + `options.token`.
   *
   * Dedup semantics:
   *   - REMOTE stores dedup by **url + scope**: a single enterprise URL
   *     legitimately hosts many scopes — the server filters reads per entry
   *     (`?scope=`), so multi-team users need one entry per authorized scope.
   *   - LOCAL stores dedup by **path only**: one engrams.yaml is one store.
   *     The loader clones global-scoped engrams into each entry's scope, so
   *     two entries on the same file would load those engrams twice.
   *
   * Returns the outcome so callers can report honestly: `added` (new entry
   * persisted), `already_registered` (idempotent no-op — `scope` is the
   * EXISTING entry's scope, which for local stores may differ from the
   * requested one), or `overwritten` (same scope reassigned to this endpoint
   * via overwriteScope).
   */
  /** mtime (ms) of config.yaml, or 0 if it cannot be stat'd. */
  /** @internal */
  statConfigMtime(): number

  /**
   * Load config.yaml for in-memory use, dropping a LOCAL store entry only when
   * it would load engrams that are already loaded, compared by canonical path:
   *
   *  - its file is the primary store: every primary engram would load a
   *    second time under namespaced ids and be injected twice; or
   *  - its file AND scope repeat an earlier entry: the same engrams again.
   *
   * One file registered under two DIFFERENT scopes keeps loading under both:
   * each scope admits different engrams, so dropping one would make that
   * scope's engrams vanish from recall. It gets an informational warning
   * instead.
   *
   * A dropped entry is only ignored here: config.yaml is not rewritten, and
   * writebacks start from the raw file (addStore / persistScopeMetadata), so
   * nothing is deleted from disk. `ignoredDuplicateStores()` reports it.
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
   * Reload this.config from disk if config.yaml changed since the last load.
   *
   * The MCP server holds ONE long-lived Plur instance, so a store added by
   * editing ~/.plur/config.yaml directly (or by another process) stays invisible
   * until the server restarts — and nothing hints why. The stores operations call
   * this first so a changed file is picked up on the next call instead of needing
   * a restart. Cheap: one statSync, reload only on an actual mtime change.
   *
   * @returns true if the config was reloaded.
   */
  /** @internal */
  reloadConfigIfChanged(): boolean

  /** Persist a new stores list to config.yaml, preserving other keys, then
   *  refresh the in-memory config + mtime. Shared by addStore's append and
   *  token-rotation paths, and by persistScopeMetadata (which passes
   *  `serverSensitivityScopes` — see {@link mergeStoresForWriteback}).
   *
   *  The read-modify-write runs under {@link withLock} on config.yaml: two
   *  concurrent persist paths (e.g. an MCP session_start metadata sync racing
   *  a CLI `plur stores add`) could otherwise each re-read the file and
   *  last-writer-wins away the other's change. Same lock discipline as
   *  engrams.yaml. Lock scope is kept tight — read + merge + write only; the
   *  in-memory refresh happens after release. */
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
   * MERGE the typed `stores` array onto the RAW (freshly-read YAML) entries so a
   * writeback never strips fields the typed schema doesn't know about.
   * `stores` is `StoreEntry[]` — the typed parse output —
   * which (without this) would clobber `configData.stores` and lose:
   *   - unknown/future TOP-LEVEL keys (recovered here; also kept by
   *     StoreEntrySchema.passthrough so the typed value already carries them)
   *   - unknown NESTED keys inside `sensitivity` (recovered by the explicit
   *     one-level deep-merge below; a shallow spread would replace `sensitivity`
   *     wholesale and lose them even with ScopeSensitivitySchema.passthrough)
   * Parsed deltas (e.g. a corrected `forbid`) land ON TOP of the raw values.
   *
   * `serverSensitivityScopes`: the scopes whose typed `sensitivity.forbid` is
   * SERVER-AUTHORITATIVE for this writeback — i.e. persistScopeMetadata just
   * synced them from `/me` — so the raw-forbid restore below must NOT undo the
   * update for those entries. Every other caller omits it and keeps the
   * restore-raw behavior.
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
   * Register a company server as one store entry and fold the per-scope
   * entries that hold the same key into it.
   *
   * Creates or updates the one server entry for the url's canonical endpoint
   * identity ({@link normalizeEndpointUrl}). A new entry gets its compat
   * `scope` here, from `personalScope` — the `user:<org>:<username>` scope of
   * the /me answer the caller already holds — so an entry
   * is never without one. A new key for the same server replaces the key in
   * that same entry (`updated`) and keeps its `scope`, `scopes`,
   * `pinned_scopes`, `scope_settings`, `discovery` and `enterprise`; no other
   * entry's key changes. `opts.enterprise` is merged into the `enterprise`
   * block. Per-scope entries on the same server whose `token`, `token_env` and
   * `readonly` equal the server entry's are folded into it
   * ({@link foldStoresIntoServerEntry}); the others are listed in
   * `kept_separate`. Two server entries for the url are refused. Taking over
   * the personal scope's writes from another entry is refused with a
   * {@link PersonalScopeTakenError} that names those entries; with
   * `removeStale` they are removed in the same write and listed in `removed`
   * (`plur login --remove-stale`).
   *
   * No network call: the caller runs `refreshServerScopes({ url })` next. The
   * read-modify-write runs under the config lock on the file as it is then and
   * is written atomically, only when something changed (`unchanged` leaves the
   * file byte-identical). With `tokenEnv` the file holds the variable's name,
   * never the key. No key reaches the result, an error or the log.
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
   * Register a remote (url) store only after the server has vouched for it.
   * {@link addStore} is synchronous and never checks the token, so an
   * installer script using it could write a dead token, or a scope the token
   * cannot reach, and learn so only at the first failed recall.
   *
   * Order: validate the URL, ask `GET /api/v1/me` with the offered token (raced
   * against `timeoutMs`), require `scope` to be among the scopes `/me`
   * authorises, THEN delegate to `addStore`. Any refusal throws an
   * {@link AddRemoteStoreError} and config.yaml is not touched.
   *
   * Idempotency and rotation come from `addStore`'s url+scope identity: an
   * identical re-run returns `already_registered` and writes nothing; the same
   * url+scope with a different token that `/me` accepts returns
   * `token_rotated` (the old token is replaced in place). A different token
   * that `/me` rejects never reaches `addStore`, so the old entry survives.
   *
   * The token never appears in the thrown message: the `/me` error text
   * includes the server's response body, which is not ours to trust, so every
   * occurrence of the token is scrubbed before it is rethrown.
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
      // The raw config is un-validated, un-salvaged on-disk YAML (persistStores
      // reads it via yaml.load, NOT loadConfig), so `sensitivity` can be ANYTHING
      // a hand-edit put there — including a truthy primitive (`sensitivity: 'oops'`,
      // `5`, `true`). loadConfig dedups nothing over `stores`, so a duplicate entry
      // on the same url+scope key can leave a primitive in rawMap (last-wins) while
      // the typed entry carries a proper object. mergeSensitivityForWriteback only
      // treats raw sensitivity as mergeable when it actually IS a plain object.
      //
      // `forbid` is a KNOWN field whose value is NORMALIZED at read time
      // (loadConfig's preprocess rewrites a forward-compat `forbid:['pii']`
      // to the safe default). A shallow `...typed.sensitivity` would then write
      // the normalized value over the raw one, ERASING the forward-compat
      // declaration on the first writeback. So when raw carried a `forbid` we
      // restore it verbatim — mirroring the nested-unknown preservation below.
      //
      // ONE deliberate exception: persistScopeMetadata DOES intentionally
      // mutate `forbid` — it syncs the server-authoritative policy from `/me`
      // — and names the affected scopes in `serverSensitivityScopes`. For
      // those entries the typed (sanitized) `forbid` must win, or the server's
      // policy change is silently discarded on every writeback and the
      // metadata change-detector can never converge (config.yaml rewritten on
      // every session_start).
      // The same rule applies inside a server entry's scope_settings:
      // collapseExpandedStores calls the same function.
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

    // Dedup: for REMOTE stores the URL alone is NOT the identity — a single
    // enterprise URL hosts many scopes (server filters reads per entry via
    // ?scope=), so only an exact url+scope match is "already registered".
    //
    // LOCAL stores keep path-only identity: one engrams.yaml is one store.
    // The loader clones global-scoped engrams into each entry's scope, so a
    // second scope on the same file would double-load those engrams.
    //
    // URL identity is NORMALIZED: `https://x.com`, `https://x.com/` and
    // `https://x.com/sse` all name the same server (RemoteStore.apiBase folds
    // them at HTTP time), so an exact-string compare here would register the
    // same url+scope twice under two spellings. Comparison-time only — the
    // stored spelling is never rewritten.
    // Local identity is the CANONICAL path: the same file spelled two ways (a
    // symlinked home, /var vs /private/var) is one store, and the primary
    // engrams.yaml is never a secondary store under any spelling — registering
    // it loads every primary engram twice.
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
