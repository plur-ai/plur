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
  normalizeEndpointUrl, redactToken, tokenFromEnv, withLock, writeConfigFile,
  PersonalScopeTakenError, type FoldReport, type OwnerOnlyResult, type Plur, type ServerDiscoveryOutcome,
} from '@plur-ai/core'
import { backupSecretFile, fetchMe, takeoverMessage, type BackupHost, type FetchFn, type MeAnswer } from './sign-in-shared.js'

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
 *   choose which key to replace.
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
  if (me.status === 'ok') return { state: 'works', token, me }
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
 * Any failure after step 2 wrote restores config.yaml's exact bytes from the
 * backup ({@link rollbackServerStore}) before the error is rethrown, so the
 * step either completes or leaves config.yaml as it was. Errors never carry
 * the key.
 */
export async function connectServerStore(opts: {
  plur: Plur
  server: string
  token: string
  personalScope: string
  configPath: string
  backupHost?: BackupHost
}): Promise<ConnectResult> {
  const { plur, server, token, configPath } = opts
  const scrub = (err: unknown): Error => {
    if (err instanceof PersonalScopeTakenError) return err
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

  let registered: Awaited<ReturnType<Plur['registerEnterpriseServer']>>
  try {
    registered = await plur.registerEnterpriseServer(server, { token, personalScope: opts.personalScope })
  } catch (err) {
    // Core wrote nothing: a refused registration leaves config.yaml as it was.
    throw scrub(err)
  }

  try {
    const outcomes = await plur.refreshServerScopes({ url: server })
    const discovery = outcomes[0] ?? {
      url: server, status: 'failed' as const, applied: false, scopes: [], rejected: [], pinned_unlisted: [],
      error: 'the server entry was not found after registration',
    }
    return { backupPath, status: registered.status, fold: registered.fold, discovery }
  } catch (err) {
    const e = scrub(err)
    try {
      rollbackServerStore(backupPath, configPath)
    } catch (rb) {
      throw new Error(`${e.message}; and config.yaml could not be restored (${scrub(rb).message})${backupPath ? `. The previous config.yaml is at ${backupPath}` : ''}`)
    }
    throw e
  }
}

/**
 * Put config.yaml back exactly as the backup holds it, under the config lock,
 * through core's protected write (owner-only, atomic). With no backup (there
 * was no config.yaml), the file is removed. Throws when the bytes read back
 * differ. Returns core's owner-only verdict on the restored file.
 */
export function rollbackServerStore(backupPath: string | null, configPath: string): OwnerOnlyResult {
  return withLock(configPath, () => {
    if (backupPath === null) {
      try { unlinkSync(configPath) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      return { ok: true } as const
    }
    const bytes = readFileSync(backupPath)
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
