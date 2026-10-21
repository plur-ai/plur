/**
 * The installer's store step (#1638, plan C Task 4): reuse a working device
 * key, register the one server store with a backup first, and roll back to
 * the backup's exact bytes.
 *
 * The key reaches config.yaml only through core: `registerEnterpriseServer`
 * (one locked, atomic, owner-only write — Unix 0600, Windows an access list
 * keyed by the account's SID) and, for a rollback, `writeConfigFile`, the
 * same protected write. Nothing here prints or logs the key, and every error
 * passes through `redactToken`. No tool config gets the key: tools reach the
 * server through PLUR, which reads config.yaml.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import {
  containsToken, normalizeEndpointUrl, redactToken, tokenFromEnv, withLock, writeConfigFile,
  PersonalScopeTakenError, SignInHeldError, type FoldReport, type OwnerOnlyResult, type Plur, type ServerDiscoveryOutcome,
} from '@plur-ai/core'
import { backupSecretFile, fetchMe, redactConsoleWith, takeoverMessage, type BackupHost, type FetchFn, type MeAnswer } from './sign-in-shared.js'

export type MeOk = Extract<MeAnswer, { status: 'ok' }>

export type ExistingKey =
  | { state: 'none' }
  | { state: 'works'; token: string; me: MeOk }
  | { state: 'rejected' }
  | { state: 'unknown'; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * A C6 server entry: a url, a `scopes` list and an `enterprise` block — the
 * same test core's `refreshServerScopes` uses. A per-scope entry (a url and
 * one `scope`) is not one; registration folds it.
 */
function isServerEntry(r: unknown): r is Record<string, unknown> & { url: string } {
  return isObj(r) && typeof r.url === 'string' && Array.isArray(r.scopes) && isObj(r.enterprise)
}

function sameServer(url: string, server: string): boolean {
  try { return normalizeEndpointUrl(url) === normalizeEndpointUrl(server) } catch { return false }
}

/**
 * Does config.yaml already hold a key for `server` that works? Finds the one
 * server entry whose url is `server` (by core's endpoint identity: a trailing
 * slash or letter case does not matter) and asks `/me` with its key (`token`,
 * else the variable `token_env` names).
 *
 * - no such entry, or no key in it → `none` (sign in);
 * - 401/403 → `rejected` (sign in; the new key replaces this one in the same
 *   entry);
 * - 503, a network error, a timeout or an unreadable answer → `unknown`: the
 *   run stops, mints no key and writes nothing (the key may still work);
 * - two entries for the server → `unknown`: registration would refuse to
 *   choose which key to replace;
 * - a 200 whose user, org or scopes repeat the key → `unknown`.
 *
 * Never throws; no result carries the key except `works.token`.
 */
export async function checkExistingKey(opts: {
  server: string
  config: { stores?: unknown[] } | null | undefined
  fetch: FetchFn
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<ExistingKey> {
  const stores = Array.isArray(opts.config?.stores) ? opts.config!.stores : []
  const entries = stores.filter(isServerEntry).filter(r => sameServer(r.url, opts.server))
  if (entries.length === 0) return { state: 'none' }
  if (entries.length > 1) return { state: 'unknown', reason: `more than one server entry in config.yaml is for ${originOf(opts.server)}` }
  const e = entries[0]
  const token = typeof e.token === 'string' && e.token ? e.token
    : tokenFromEnv(typeof e.token_env === 'string' ? e.token_env : undefined, opts.env ?? process.env)
  if (!token) return { state: 'none' }
  const me = await fetchMe(originOf(opts.server), token, { fetch: opts.fetch, timeoutMs: opts.timeoutMs })
  if (me.status === 'ok') {
    // A server that repeats the key as the user, the org or a scope: not an
    // answer to build on, and every later print of it would show the key.
    if ([me.username, me.orgId, ...me.scopes].some(v => containsToken(v, token))) {
      return { state: 'unknown', reason: 'the server\'s /me answer repeats the key' }
    }
    return { state: 'works', token, me }
  }
  if (me.status === 'rejected') return { state: 'rejected' }
  return { state: 'unknown', reason: redactToken(me.reason, token) }
}

function originOf(server: string): string {
  try { return new URL(server).origin } catch { return server }
}

export interface ConnectResult {
  /** The owner-only copy of config.yaml taken before the write; null when there was no config.yaml. */
  backupPath: string | null
  status: 'added' | 'updated' | 'unchanged'
  fold: FoldReport
  discovery: ServerDiscoveryOutcome
  migratedLegacy?: boolean
  /** Restore only this uninterrupted sequence of writes; never serialize its private snapshots. */
  rollback: () => OwnerOnlyResult
}

/**
 * Register `server` as the one server store with `token`, then fetch its
 * scopes.
 *
 * 1. config.yaml is copied, owner-only, to `<plur dir>/backups/<stamp>/` —
 *    before anything is written. A copy that cannot be made owner-only stops
 *    here: nothing is registered.
 * 2. `registerEnterpriseServer(server, { token, personalScope })`: a new key
 *    for the same server replaces the key in that entry (index decision 2);
 *    `personalScope` is the `/me` answer's (owner decision O6). A refusal
 *    writes nothing and is rethrown — a {@link PersonalScopeTakenError} keeps
 *    its type so the caller can offer the cleanup ({@link storeRefusalLines}).
 * 3. `refreshServerScopes({ url: server })`.
 *
 * Any failure after registration may have written — a throw from
 * registration other than a refusal, or a throw from the refresh — restores
 * config.yaml's exact bytes from the backup ({@link rollbackServerStore})
 * before the error is rethrown. A discovery that RETURNS a failed,
 * auth_failed or not_synced outcome is not a throw: the key stays and the
 * outcome is returned, because the installer's run decides (it continues on
 * not_synced, and rolls back with `backupPath` only when a newly minted key
 * saved nothing). While the step runs, console output is redacted with the
 * key (core logs server-supplied text, which could repeat it), and the
 * result is redacted too. Errors never carry the key.
 */
export async function connectServerStore(opts: {
  plur: Plur
  server: string
  token: string
  personalScope: string
  configPath: string
  backupHost?: BackupHost
  migrateLegacyPersonal?: boolean
}): Promise<ConnectResult> {
  const { plur, server, token, configPath } = opts
  const scrub = (err: unknown): Error => {
    if (err instanceof PersonalScopeTakenError) {
      // Keeps its type and fields for storeRefusalLines; a server can name
      // a personal scope that repeats the key, so every field is redacted.
      return new PersonalScopeTakenError(redactToken(err.message, token), redactToken(err.personalScope, token),
        redactDeep(err.holders, token), err.removable)
    }
    return new Error(redactToken(err instanceof Error ? err.message : String(err), token))
  }

  let backupPath: string | null = null
  if (existsSync(configPath)) {
    try {
      backupPath = backupSecretFile(dirname(configPath), configPath, opts.backupHost)
    } catch (err) {
      throw new Error(`config.yaml could not be backed up before saving the key (${scrub(err).message}). Nothing was changed.`)
    }
  }

  const undoConsole = redactConsoleWith(token)
  let expected = backupPath ? readFileSync(backupPath, 'utf8') : null
  const original = expected
  let interrupted = false
  const onConfigWrite = (before: string | null, after: string) => {
    if (before !== expected) interrupted = true
    expected = after
  }
  const rollback = (): OwnerOnlyResult => {
    if (interrupted) throw new Error('config.yaml changed during installation; it was preserved. Inspect the backup before restoring it.')
    return rollbackServerStore(backupPath, configPath, expected === null ? null : Buffer.from(expected), original === null ? undefined : Buffer.from(original))
  }
  try {
    let registered: Awaited<ReturnType<Plur['registerEnterpriseServer']>>
    try {
      registered = await plur.registerEnterpriseServer(server, { token, personalScope: opts.personalScope, onConfigWrite,
        ...(opts.migrateLegacyPersonal ? { migrateLegacyPersonal: true, beforeLegacyMigration: (path: string) => {
          if (!backupPath || readFileSync(path, 'utf8') !== expected || readFileSync(backupPath, 'utf8') !== expected) {
            throw new Error('The legacy configuration changed after its backup. Nothing was changed; retry installation.')
          }
        } } : {}),
      })
    } catch (err) {
      // A refusal writes nothing. Any other throw may come after core wrote
      // (a reload after the write, say): put the backup back first.
      if (err instanceof PersonalScopeTakenError) throw scrub(err)
      if (err instanceof SignInHeldError) throw new SignInHeldError(redactToken(err.message, token))
      throw restoreThen(scrub(err), backupPath, rollback, scrub)
    }

    try {
      const outcomes = await plur.refreshServerScopes({ url: server, onConfigWrite })
      const discovery = outcomes[0] ?? {
        url: server, status: 'failed' as const, applied: false, scopes: [], rejected: [], pinned_unlisted: [],
        error: 'the server entry was not found after registration',
      }
      return { ...redactDeep({ backupPath, status: registered.status, fold: registered.fold, discovery, ...(registered.migratedLegacy ? { migratedLegacy: true } : {}) }, token), rollback }
    } catch (err) {
      throw restoreThen(scrub(err), backupPath, rollback, scrub)
    }
  } finally {
    undoConsole()
  }
}

/**
 * `value` with every string AND every property name redacted with `token`
 * (core's `redactTokenDeep` leaves names, and `queued_by_scope` is keyed by
 * scope). Two names that redact alike: numbers are added, else the first is kept.
 */
function redactDeep<T>(value: T, token: string): T {
  if (typeof value === 'string') return redactToken(value, token) as unknown as T
  if (Array.isArray(value)) return value.map(v => redactDeep(v, token)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rk = redactToken(k, token)
      const rv = redactDeep(v, token)
      if (!(rk in out)) out[rk] = rv
      else if (typeof out[rk] === 'number' && typeof rv === 'number') out[rk] = (out[rk] as number) + rv
    }
    return out as T
  }
  return value
}

/** Roll back, then hand back `e` (or, when the restore failed, an error naming both and the backup). */
function restoreThen(e: Error, backupPath: string | null, rollback: () => OwnerOnlyResult, scrub: (err: unknown) => Error): Error {
  try {
    rollback()
  } catch (rb) {
    return new Error(`${e.message}; and config.yaml could not be restored (${scrub(rb).message})${backupPath ? `. The previous config.yaml is at ${backupPath}` : ''}`)
  }
  return e
}

/**
 * Put config.yaml back exactly as the backup holds it, under the config lock,
 * through core's protected write (owner-only, atomic). With no backup (there
 * was no config.yaml), the file is removed. Throws when the bytes read back
 * differ. Returns core's owner-only verdict on the restored file.
 */
export function rollbackServerStore(backupPath: string | null, configPath: string, expectedCurrent?: Buffer | null, expectedBackup?: Buffer): OwnerOnlyResult {
  return withLock(configPath, () => {
    // A subprocess may have run since registration. Refuse to overwrite an
    // intervening configuration change, even while holding the restore lock.
    if ((expectedCurrent === null && existsSync(configPath)) ||
        (expectedCurrent && (!existsSync(configPath) || !readFileSync(configPath).equals(expectedCurrent)))) {
      throw new Error('config.yaml changed during installation; it was preserved. Inspect the backup before restoring it.')
    }
    if (backupPath === null) {
      try { unlinkSync(configPath) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      return { ok: true } as const
    }
    const bytes = readFileSync(backupPath)
    if (expectedBackup && !bytes.equals(expectedBackup)) throw new Error('The configuration backup changed; config.yaml was preserved.')
    const r = writeConfigFile(configPath, bytes)
    if (!readFileSync(configPath).equals(bytes)) throw new Error('config.yaml does not match its backup after the restore')
    return r
  })
}

/**
 * What the installer prints when registration is refused because another
 * entry holds the personal scope (owner decision on B5: refuse, and offer the
 * cleanup): the entries, and `plur login <server> --remove-stale` (backs
 * config.yaml up, removes them, signs in), then the installer again — which
 * then finds the working key. `reused`: the key was already in config.yaml,
 * so nothing from this run was lost.
 */
export function storeRefusalLines(err: PersonalScopeTakenError, server: string, configPath: string, o: { reused: boolean }): string[] {
  const origin = originOf(server)
  return [
    ...takeoverMessage(err, origin, configPath, {
      lead: `The installer did not save ${origin}:`,
      notSaved: o.reused ? '' : ', and the key from this sign-in was not saved',
      rerun: 'run the installer again',
    }),
    ...(err.removable ? ['Then run the installer again.'] : []),
  ]
}
