import * as fs from 'fs'
import yaml from 'js-yaml'
import { writeConfigFile } from '../config-file.js'
import { appendHistory, type HistoryEvent as HistoryEventType } from '../history.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { containsEmail } from '../packs.js'
import { FileProvenanceStore, provenanceMode, type ProvenanceStore } from '../provenance-store.js'
import { buildProvenanceRecord, type ProvenanceOptions } from '../provenance.js'
import { isRemoteOnlyQueued } from '../remote-only-rows.js'
import {
    RemoteOnlyWriteError
} from '../remote-only.js'
import type { Engram } from '../schemas/engram.js'
import { ATTRIBUTION_UNIDENTIFIED } from '../schemas/engram.js'
import { withLock } from '../file-lock.js'
import type {
    LearnContext
} from '../types.js'

export interface ProvenanceIdentityMethods {
  /** Build the {scope, session_id, stored_at} source entry that gets appended
   * to an engram's sources[] on every write (initial or duplicate). */
  /**
   * Build a provenance record for an engram, without storing it.
   *
   * Defaults to a portable record: one that stands on its own, names no other
   * engram, and can be handed to someone who has none of our files.
   */
  provenanceFor(engramId: string, options?: ProvenanceOptions): Promise<unknown | undefined>

  /**
   * Build a provenance record and store it.
   *
   * Returns the reference the store gave back, or undefined when the engram is
   * unknown. Storage is pluggable: pass a store, or let it default to files
   * under the PLUR home directory.
   */
  writeProvenance(engramId: string, options?: ProvenanceOptions & { store?: ProvenanceStore }): Promise<string | undefined>

  /**
   * Append a history event, stamped with who caused it.
   *
   * Every event site goes through here rather than calling `appendHistory`
   * directly, so a new event type gets an actor without its author having to
   * know that it should.
   *
   * A caller that knows better — a dedup pass acting on behalf of somebody
   * else, say — passes its own `actor` and this leaves it alone.
   *
   * The actor answers a DIFFERENT question from the engram's `attribution`.
   * Attribution says who asserted the statement; this says who caused this
   * event. An engram asserted by one person and retired by another has two
   * answers, and collapsing them loses both — which is precisely what a reader
   * auditing a correction needs to know.
   */
  /**
   * @returns whether the event was written — propagated from `appendHistory`,
   *   which reports rather than throws. `inject()` gates `injection_count` on
   *   this, so swallowing it here would put the counter out of step with the log.
   */
  /** @internal */
  _appendHistory(event: HistoryEventType): boolean

  /**
   * The recorded ancestors of one engram, for extending a derivation chain.
   *
   * Reads the chain the ancestor already carries rather than walking the graph
   * again — each engram's chain was resolved when it was written, so this is
   * one lookup deep instead of a traversal per write.
   *
   * Takes the already-loaded engram list rather than reading the store: both
   * call sites have it in hand, and a store read inside the write path would
   * add latency to every learn for a field that is a convenience. An ancestor
   * that is not in the list contributes nothing, which shortens the chain and
   * never fails the write.
   */
  /** @internal */
  _ancestorsOf(loaded: Engram[], id: string): string[]

  /**
   * The identity this user configured, if any (`provenance.identity`).
   *
   * Returns undefined when unset, and `buildAttribution` then writes the
   * `unidentified` marker. Never falls back to the operating system account.
   */
  /** @internal */
  _configuredIdentity(): string | undefined

  /**
   * Who new memories will be attributed to, and whether anybody chose that.
   *
   * Exposed so a surface can ask before writing — the CLI prompts on `init`,
   * and `plur identity` reports it. `stated: false` means every engram written
   * from here is recorded as `unidentified`, which is honest but answers
   * nobody's question about who is responsible.
   */
  identity(): { identity: string; stated: boolean }

  /**
   * Set, change, or clear who memories are attributed to.
   *
   * Applies to memories written from now on. Existing engrams keep whatever was
   * recorded at the time, which is the point of recording it — rewriting them
   * would be editing history to match a later decision.
   */
  setIdentity(identity: string | null): { identity: string; stated: boolean; warning?: string }

  /** @internal */
  _provenanceStore(): ProvenanceStore

  /**
   * Write a record at creation time, when the setting asks for it.
   *
   * Default is `never`: a record per engram duplicates the history log, and the
   * trust boundary is the moment an engram leaves, not the moment it is written.
   * Never throws — provenance is a description, and failing to write one must
   * not fail the learn that prompted it.
   */
  /**
   * Run fire-and-forget work only once the store has committed.
   *
   * A transactional store runs a protected write inside one connection and one
   * ownership context. Background work started inside that context would
   * inherit it, then fail once the transaction ends, or run against state that
   * a later rollback discards. Stores without transactions run it immediately.
   */
  /** @internal */
  _afterStoreCommit(callback: () => void): void

  /** @internal */
  _maybeWriteProvenance(engramId: string, row?: Engram): void

  /** @internal */
  _buildSourceEntry(scope: string, context?: LearnContext): {
    scope: string; session_id: string | null; stored_at: string
  }
}

export const provenanceIdentityMethods: ProvenanceIdentityMethods & ThisType<Plur> = {
  async provenanceFor(engramId: string, options: ProvenanceOptions = {}): Promise<unknown | undefined> {
    const engram = await this.getById(engramId)
    if (!engram) return undefined
    // A scope backed by a remote store on this install leaves the machine;
    // only this instance knows its stores, so read the current config.
    this.reloadConfigIfChanged()
    const cfg = (this.config as any)?.provenance
    return buildProvenanceRecord(engram, this.getEngramHistory(engramId), {
      includeStatement: cfg?.include_statement ?? false,
      // Writable URL stores only: a readonly one is not a path off the machine,
      // and not knowing can only withhold more.
      remoteBacked: this._isRemoteWriteScope(engram.scope),
      ...options,
    })
  },

  async writeProvenance(engramId: string, options: ProvenanceOptions & { store?: ProvenanceStore } = {}): Promise<string | undefined> {
    // remote-only: a provenance record can carry the statement, and the
    // default store is this machine's disk.
    if (this._activeBinding()) throw this._remoteOnlyError('local-store', undefined, 'Writing a provenance record')
    // A queued remote-only save gets no local provenance, bound or not.
    const queuedRow = (await this._basePrimaryStore.loadCached()).find(e => e.id === engramId)
    if (queuedRow && isRemoteOnlyQueued(queuedRow)) throw this._queuedStaysRemote(queuedRow)
    const record = await this.provenanceFor(engramId, options)
    if (!record) return undefined
    const store = options.store ?? this._provenanceStore()
    return store.put(engramId, record)
  },

  _appendHistory(event: HistoryEventType): boolean {
    // remote-only: the local history never holds free text — events keep ids,
    // scopes, counts, flags and enum-like values, never a statement, preview,
    // reason or message.
    if (this._activeBinding() && (event as any).data) {
      event = { ...(event as any), data: Plur._metadataOnly((event as any).data) } as HistoryEventType
    }
    if (!event.actor) {
      event.actor = {
        asserted_by: this._configuredIdentity() ?? ATTRIBUTION_UNIDENTIFIED,
        runtime: { name: 'plur-core' },
      }
    }
    return appendHistory(this.paths.root, event)
  },

  _ancestorsOf(loaded: Engram[], id: string): string[] {
    const engram = loaded.find(e => e.id === id)
    const chain = (engram as { provenance?: { chain?: string[] } } | undefined)?.provenance?.chain
    return Array.isArray(chain) ? chain : []
  },

  _configuredIdentity(): string | undefined {
    const id = (this.config as any)?.provenance?.identity
    return typeof id === 'string' && id.trim() ? id.trim() : undefined
  },

  identity(): { identity: string; stated: boolean } {
    const configured = this._configuredIdentity()
    return { identity: configured ?? ATTRIBUTION_UNIDENTIFIED, stated: Boolean(configured) }
  },

  setIdentity(identity: string | null): { identity: string; stated: boolean; warning?: string } {
    const value = typeof identity === 'string' ? identity.trim() : ''
    // An email address is the most natural identity to type and the one that
    // silently breaks sharing: the export privacy scan flags email addresses,
    // so every memory attributed this way is dropped from every pack.
    // Accept it — it is the user's decision — but say so at the moment they
    // choose it rather than at the first empty export.
    const warning = value && containsEmail(value)
      ? `"${value}" is an email address. The pack export privacy scan flags email addresses, so memories `
        + 'attributed to it are held back from every pack until #999 lands. Prefer a local name '
        + '(local:yourname) or a DID if you intend to share.'
      : undefined
    if (warning) logger.warning(`[plur:identity] ${warning}`)
    // Same read-modify-write discipline as every other config mutation here:
    // under the config lock, and written atomically. A plain write truncates in
    // place, and a parse failure makes loadConfig fall back to DEFAULT config —
    // so a crash mid-write would silently erase store registrations too.
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      const provenance = (configData.provenance as Record<string, unknown> | undefined) ?? {}
      if (value) provenance.identity = value
      else delete provenance.identity
      configData.provenance = provenance
      writeConfigFile(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
    })
    this.config = this._loadConfig()
    this.configMtimeMs = this.statConfigMtime()
    return { ...this.identity(), ...(warning ? { warning } : {}) }
  },

  _provenanceStore(): ProvenanceStore {
    if (!this._provenanceStoreInstance) {
      this._provenanceStoreInstance = new FileProvenanceStore(
        this.paths.root,
        this.config.provenance?.path,
      )
    }
    return this._provenanceStoreInstance
  },

  _afterStoreCommit(callback: () => void): void {
    if (this._primaryStore.afterCommit) this._primaryStore.afterCommit(callback)
    else callback()
  },

  _maybeWriteProvenance(engramId: string, row?: Engram): void {
    if (provenanceMode(this.config) !== 'always') return
    // remote-only: no provenance kept on this machine, bound, or for a queued
    // remote-only save being delivered.
    if (this._activeBinding() || isRemoteOnlyQueued(row)) return
    this._afterStoreCommit(() => {
      void this.writeProvenance(engramId).catch(err => {
        if (err instanceof RemoteOnlyWriteError) return
        logger.warning(`[plur:provenance] could not write a record for ${engramId}: ${(err as Error).message}`)
      })
    })
  },

  _buildSourceEntry(scope: string, context?: LearnContext): {
    scope: string; session_id: string | null; stored_at: string
  } {
    // One emptiness rule: an empty string counts as absent, so
    // `session_id: ''` never wins over a genuine `session_episode_id`.
    const present = (v: unknown): v is string => typeof v === 'string' && v.length > 0
    // Only `session_id` is a session in the provenance sense. `session` selects
    // the default scope and can hold an internal registry key or
    // NO_SESSION, so it is never recorded here.
    const sessionId = context?.session_id
    return {
      scope,
      // session_id takes precedence over session_episode_id.
      session_id: present(sessionId) ? sessionId
        : present(context?.session_episode_id) ? context!.session_episode_id!
        : null,
      stored_at: new Date().toISOString(),
    }
  },
}
