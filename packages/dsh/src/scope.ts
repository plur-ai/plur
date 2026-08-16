/**
 * Per-session PLUR scope resolution.
 *
 * dsh's default profile is a multi-session web server, so one plugin instance
 * serves several concurrent agents. A single global scope would let engrams from
 * one project surface in another's context — silently wrong retrieval, which is
 * worse for a memory product than slow retrieval.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/** Last-resort scope when there is no workspace to derive one from. */
export const DEFAULT_SCOPE = 'project:dsh'

/** Resolves which PLUR scope one live agent may read and write. */
export interface ScopeResolver {
  /**
   * The scope for one agent, memoised after the first call.
   *
   * @param agentId - the live agent's id.
   * @param cwd - the session workspace, when it has one.
   * @returns the resolved scope; never the ambient global store.
   */
  resolve(agentId: string, cwd: string | undefined): Promise<string>
  /** Forget an agent when its session ends. */
  clear(agentId: string): void
}

/**
 * Build the per-agent scope resolver.
 *
 * Precedence: the session workspace's own declared scope, then the configured
 * default. The ambient global store is never a fallback — a third-party harness
 * must not inherit every engram the user has ever stored merely by being
 * installed. A broken or unreadable workspace file narrows to the default rather
 * than widening, because failing open on a privacy boundary is the wrong
 * direction to fail.
 *
 * @param config - carries the configured default scope.
 * @param readWorkspaceScope - reads a workspace's declared scope, if any.
 * @returns the resolver.
 */
export function createScopeResolver(
  config: { scope?: string },
  readWorkspaceScope: (cwd: string) => Promise<string | undefined>,
): ScopeResolver {
  // Keyed by agent AND cwd: a host may reuse an agent id, or move an existing
  // agent to a different workspace without emitting `agent/disposed`. Memoising
  // on the id alone would then serve the previous workspace's scope.
  const resolved = new Map<string, string>()
  const keyFor = (agentId: string, cwd: string | undefined) => `${agentId}\u0000${cwd ?? ''}`

  return {
    async resolve(agentId, cwd) {
      const key = keyFor(agentId, cwd)
      const cached = resolved.get(key)
      if (cached !== undefined) return cached

      let scope: string | undefined
      if (cwd !== undefined) {
        try {
          // Only a NON-EMPTY declaration counts. `??=` below does not fire on an
          // empty string, so assigning '' here would let a blank `scope:` key in
          // a .plur.yaml silently become the effective scope.
          const declared = await readWorkspaceScope(cwd)
          if (declared) scope = declared
        } catch {
          // A broken workspace file must neither widen the scope nor break the turn.
        }
      }
      // An explicitly configured scope beats derivation, but the DEFAULT must not
      // be one shared literal: two unconfigured repos sharing `project:dsh` is a
      // cross-project leak between exactly the users least likely to notice.
      // Derive per workspace, the way @plur-ai/core's own store discovery does.
      scope ??= config.scope ?? (cwd ? derive(cwd) : DEFAULT_SCOPE)
      resolved.set(key, scope)
      return scope
    },
    clear(agentId) {
      for (const key of resolved.keys()) {
        if (key.startsWith(`${agentId}\u0000`)) resolved.delete(key)
      }
    },
  }
}

/**
 * Build the read filter for one resolved scope.
 *
 * Always sets `scopes`, core's authorization allow-list. `scope` alone is a
 * visibility filter that passes the whole personal family and does not
 * isolate: with only `scope`, a `project:beta` injection surfaced
 * `project:alpha`'s engrams — verified against the real engine.
 *
 * @param scope - the session's resolved scope.
 * @param includeGlobal - whether global engrams accompany it.
 * @returns the options every read should spread.
 */
export function readScope(scope: string, includeGlobal: boolean): { scope: string; scopes: string[] } {
  return {
    scope,
    scopes: includeGlobal && scope !== 'global' ? [scope, 'global'] : [scope],
  }
}

/**
 * Derive a scope from a workspace path.
 *
 * The directory NAME alone collides: `~/clients/acme/api` and
 * `~/clients/northwind/api` both become `project:api`, pooling two clients'
 * engrams — and `api`, `web`, `server`, `docs` are the common cases, so this is
 * the normal outcome rather than an edge one. A short digest of the full path
 * disambiguates while keeping the name readable, which matters because this
 * string is what a user sees in `plur ui` and types into `.plur.yaml`.
 *
 * @param cwd - the workspace directory.
 * @returns the derived scope.
 */
function derive(cwd: string): string {
  // Normalise FIRST. Hashing the raw string meant `/w/proj` and `/w/proj/`
  // were different scopes for the same directory — a host that ever reports a
  // trailing slash, or a user on a symlinked checkout, silently got a second
  // empty store and two entries in `plur ui`. realpath additionally collapses
  // symlinks; it throws on a path that does not exist, which is ordinary for a
  // workspace the host names before creating, so fall back to resolve().
  let path = cwd
  try {
    path = realpathSync.native(cwd)
  } catch {
    path = resolve(cwd)
  }
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 6)
  // `basename('/')` is '' and `basename('/x/.')` is '.', neither of which is a
  // name anyone can type into .plur.yaml.
  const name = basename(path) || 'root'
  return `project:${name === '.' ? 'root' : name}-${digest}`
}

