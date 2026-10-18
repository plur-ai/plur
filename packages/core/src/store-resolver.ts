import type { StoreEntry } from './schemas/config.js'
import { personalStoreEntry } from './scope-target.js'
import { normalizeEndpointUrl } from './store/remote-store.js'
import { scopeOrg } from './remote-recall.js'

/**
 * Where a write to a scope goes (#1631). ONE answer, read by write routing,
 * the leak guard's remote-backed check and the delivery report, so the three
 * can never disagree about whether a save leaves this machine.
 */
export type ScopeTarget =
  /** A url store claims exactly this scope (one server). */
  | { kind: 'remote'; entry: StoreEntry; writable: boolean }
  /** Two or more distinct servers claim exactly this scope: refuse the write. */
  | { kind: 'conflict'; servers: string[] }
  /** Under a company server's org (`discovery.org_id`), but not granted to you. */
  | { kind: 'unauthorized'; server: string }
  /** A path store, or no store: the write stays on this machine. */
  | { kind: 'local'; entry?: StoreEntry }

/**
 * A scope claimed by two servers. Thrown by the write path before anything is
 * saved, and by the explicit-scope id lookups (forget, feedback, setPinned;
 * #1633 row 34) before any server is asked: `outcome` says what did not happen.
 */
export class ScopeConflictError extends Error {
  readonly scope: string
  readonly servers: string[]
  constructor(scope: string, servers: string[], outcome = 'nothing was saved') {
    super(
      `Scope "${scope}" is claimed by two servers (${servers.join(', ')}); ${outcome}. ` +
      'Remove it from one of them in config.yaml.',
    )
    this.name = 'ScopeConflictError'
    this.scope = scope
    this.servers = servers
  }
}

/**
 * A server's url as the resolver names it: {@link normalizeEndpointUrl}, with
 * any userinfo removed so a token in a url never reaches a message.
 */
export function serverName(url: string): string {
  let clean = url
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = ''
      u.password = ''
      clean = u.toString()
    }
  } catch { /* not a parseable url: keep it as written */ }
  return normalizeEndpointUrl(clean)
}

/**
 * The url entries whose scope is exactly `scope`, grouped by server
 * ({@link normalizeEndpointUrl}), each group in config order. Ignores the
 * personal-store selection: the leak guard and the outbox lookups ask "does
 * any server claim this scope", not "where does this write go".
 */
export function urlGroupsForScope(scope: string, stores: readonly StoreEntry[]): StoreEntry[][] {
  const groups = new Map<string, StoreEntry[]>()
  for (const s of stores) {
    if (!s.url || s.scope !== scope) continue
    const key = normalizeEndpointUrl(s.url)
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }
  return [...groups.values()]
}

function remoteOf(group: StoreEntry[]): ScopeTarget {
  // The entry a write goes through is the first WRITABLE one, so the driver
  // and the outbox target agree; a readonly-only group answers its first.
  const writableEntry = group.find(s => s.readonly !== true)
  return { kind: 'remote', entry: writableEntry ?? group[0], writable: writableEntry !== undefined }
}

/**
 * Resolve where a write to `scope` goes, given the configured (expanded)
 * stores. Pure: no driver, no network, no config reload.
 *
 * Rules, in order:
 * 1. A personal `user:` scope that exactly names a store → the ONE selected
 *    entry (`personalStoreEntry`: local first, then writable url, then
 *    readonly url; #1515 unchanged).
 * 2. Exact-scope url entries, grouped by server. Two or more servers →
 *    `conflict`; one → `remote`.
 * 3. No exact url entry, but a company server (an entry with an `enterprise`
 *    block) whose `discovery.org_id` is the scope's org → `unauthorized`.
 * 4. A path entry with the exact scope → `local` with it.
 * 5. Else `local`.
 *
 * Matching is exact throughout: a store whose scope merely contains `scope`
 * does not route it.
 */
export function resolveScopeTarget(scope: string, stores: readonly StoreEntry[]): ScopeTarget {
  if (scope.toLowerCase().startsWith('user:') && stores.some(s => s.scope === scope)) {
    const selected = personalStoreEntry(scope, stores.filter(s => typeof s.scope === 'string'))
    if (selected?.url) return { kind: 'remote', entry: selected, writable: selected.readonly !== true }
    return selected ? { kind: 'local', entry: selected } : { kind: 'local' }
  }

  const groups = urlGroupsForScope(scope, stores)
  if (groups.length >= 2) return { kind: 'conflict', servers: groups.map(g => serverName(g[0].url!)) }
  if (groups.length === 1) return remoteOf(groups[0])

  const org = scopeOrg(scope)
  if (org) {
    const server = stores.find(s => {
      const x = s as unknown as { enterprise?: unknown; discovery?: { org_id?: unknown } }
      return !!s.url
        && !!x.enterprise && typeof x.enterprise === 'object'
        && typeof x.discovery?.org_id === 'string'
        && x.discovery.org_id.toLowerCase() === org
    })
    if (server) return { kind: 'unauthorized', server: serverName(server.url!) }
  }

  const local = stores.find(s => !s.url && s.scope === scope)
  return local ? { kind: 'local', entry: local } : { kind: 'local' }
}
