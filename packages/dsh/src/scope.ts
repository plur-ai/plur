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
 * Build the per-agent scope resolver: the workspace's declared scope, else the configured
 * default — never the ambient global store. A broken workspace file narrows to the default
 * (fail closed on a privacy boundary).
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
 * Build the read filter for one resolved scope. Always sets `scopes` (core's authorization
 * allow-list): `scope` alone passes the whole personal family and does not isolate.
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
 * Derive a scope from a workspace path: the directory name plus a short digest of the full
 * path, since bare names (`api`, `web`) collide across clients. Kept readable because users
 * see it in `plur ui` and type it into `.plur.yaml`.
 * @param cwd - the workspace directory.
 * @returns the derived scope.
 */
function derive(cwd: string): string {
  // Normalise FIRST, or `/w/proj` and `/w/proj/` (or a symlinked checkout)
  // become different scopes for the same directory. realpath also collapses
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

