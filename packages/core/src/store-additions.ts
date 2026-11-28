/**
 * What a rewrite of config.yaml's `stores` list adds (0.24 review round 6).
 *
 * A store is a source of rows, and its pinned rows load into every session,
 * so under `pinning.agents` request/deny only the owner may add one. This is
 * the single definition of "adds", read by the two writers of the list
 * (`persistStores`, `_updateRawStores`) on the entries read from disk under
 * the config lock and the entries about to be written.
 *
 * - A source is where rows come from: a remote endpoint
 *   ({@link normalizeEndpointUrl} of `url`, for a server entry and a
 *   per-scope url entry alike) or a local store file (its canonical path).
 *   `newSources` are the sources the new list has and the old one did not.
 * - `newScopes` are `scope@source` pairs an EXISTING source serves in the new
 *   list and did not serve in the old one: a new scope on a known server, or
 *   a scope a known server now serves that only another store served before.
 *   The scopes of a new source are not listed again; `newSources` names it.
 * - `newServerEntries` are urls that have a server entry (url + `scopes`) in
 *   the new list and had none in the old one. A server entry grows by its
 *   own scope refresh (#1940), so turning a url's per-scope entries into a
 *   server entry is an addition even when the scopes are the same (round 7).
 *
 * Not an addition: removing an entry, reordering, a new token or token_env
 * on an existing source, re-saving an entry, folding per-scope entries of a
 * url into the server entry that url already has, and metadata (covers,
 * description, sensitivity, discovery, readonly, shared).
 */
import { canonicalize } from './project-config.js'
import { servedScopes } from './server-discovery.js'
import { normalizeEndpointUrl } from './store/remote-store.js'
import { isServerStoreEntry } from './store-expand.js'
import { PinDeniedError, type PinActor } from './pin-policy.js'

export interface StoreAdditions {
  newSources: string[]
  newScopes: string[]
  newServerEntries: string[]
}

/** The source of one raw entry, or null for an entry that names none. */
export function storeSourceOf(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as { url?: unknown; path?: unknown }
  if (typeof e.url === 'string' && e.url !== '') return `url:${normalizeEndpointUrl(e.url)}`
  if (typeof e.path === 'string' && e.path !== '') {
    let p = e.path
    try { p = canonicalize(e.path) } catch { /* keep as written */ }
    return `path:${p}`
  }
  return null
}

function served(list: readonly unknown[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const entry of list) {
    const source = storeSourceOf(entry)
    if (source === null) continue
    let scopes = out.get(source)
    if (!scopes) { scopes = new Set(); out.set(source, scopes) }
    for (const s of servedScopes(entry)) scopes.add(s)
  }
  return out
}

/** Sources (url:...) that have a server entry in `list`. */
function serverEntryUrls(list: readonly unknown[]): Set<string> {
  const out = new Set<string>()
  for (const entry of list) {
    if (!isServerStoreEntry(entry)) continue
    const source = storeSourceOf(entry)
    if (source !== null) out.add(source)
  }
  return out
}

export function storeAdditions(beforeRaw: readonly unknown[], afterRaw: readonly unknown[]): StoreAdditions {
  const before = served(beforeRaw)
  const after = served(afterRaw)
  const newSources: string[] = []
  const newScopes: string[] = []
  for (const [source, scopes] of after) {
    const had = before.get(source)
    if (!had) { newSources.push(source); continue }
    for (const s of scopes) if (!had.has(s)) newScopes.push(`${s}@${source}`)
  }
  const hadServer = serverEntryUrls(beforeRaw)
  // A brand-new source is already named in newSources.
  const newServerEntries = [...serverEntryUrls(afterRaw)].filter(u => !hadServer.has(u) && before.has(u))
  return { newSources, newScopes, newServerEntries }
}

export function hasStoreAdditions(a: StoreAdditions): boolean {
  return a.newSources.length > 0 || a.newScopes.length > 0 || a.newServerEntries.length > 0
}

/**
 * Who is writing config.yaml's stores list, required by both writers so
 * every caller names it:
 * - `caller`: a store registration on behalf of `actor` (else the instance's
 *   default actor). An addition by a caller the pin policy restricts is
 *   refused with PinDeniedError (its text from `refusal`), and nothing is written.
 * - `server-refresh`: a server's own scope refresh. It may add scopes to a
 *   server already listed (#1940); a new source is an internal error.
 * - `metadata`: covers, descriptions, sensitivity and similar; any addition
 *   is an internal error.
 */
export type StoreWriteAuthority =
  | { kind: 'caller'; actor?: PinActor; refusal?: (decision: string) => string }
  | { kind: 'server-refresh' }
  | { kind: 'metadata' }

/**
 * A write the rule stops because it would add what its authority may not
 * (a server refresh adding a source, a metadata write adding anything):
 * a stale read or a bug, not a policy answer to show a user.
 */
export class StoreWriteConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreWriteConflictError'
  }
}

/** The refusal text of a store registration by a restricted caller. */
export function storeRegistrationRefusal(decision: string, ask = '`plur stores add`'): string {
  return `Registering a store is reserved for the owner on this install (pinning.agents: ${decision}), because a store's pinned `
    + `engrams load into every session. Nothing was registered. Ask the owner to run ${ask} in a terminal.`
}

/**
 * Apply `authority` to a rewrite of the stores list from `beforeRaw` (read
 * under the config lock) to `afterRaw` (about to be written). Throws to stop
 * the write; returns when it may go ahead. `decide` is the instance's pin
 * decision for an actor. Under pinning.agents request or deny, an addition by
 * a caller the pin policy restricts is refused and nothing is written.
 */
export function checkStoreWrite(
  beforeRaw: readonly unknown[],
  afterRaw: readonly unknown[],
  authority: StoreWriteAuthority | undefined,
  decide: (actor: PinActor | undefined) => string,
): void {
  const additions = storeAdditions(beforeRaw, afterRaw)
  if (!hasStoreAdditions(additions)) return
  // A writer reached without an authority (an older internal call) is held
  // to the caller rule for the instance's default actor.
  const a: StoreWriteAuthority = authority ?? { kind: 'caller' }
  if (a.kind === 'server-refresh') {
    if (additions.newSources.length === 0 && additions.newServerEntries.length === 0) return
    throw new StoreWriteConflictError(`internal: a server scope refresh would add a new store (${additions.newSources.length + additions.newServerEntries.length} source); nothing was written`)
  }
  if (a.kind === 'metadata') {
    throw new StoreWriteConflictError(`internal: a metadata write would add ${additions.newSources.length ? 'a new store' : 'a new scope'} to config.yaml; nothing was written`)
  }
  const decision = decide(a.actor)
  if (decision !== 'allow') {
    throw new PinDeniedError(null, 'stores.add', (a.refusal ?? storeRegistrationRefusal)(decision))
  }
}
