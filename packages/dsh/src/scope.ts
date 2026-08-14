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
  config: { scope: string },
  readWorkspaceScope: (cwd: string) => Promise<string | undefined>,
): ScopeResolver {
  const resolved = new Map<string, string>()
  return {
    async resolve(agentId, cwd) {
      const cached = resolved.get(agentId)
      if (cached !== undefined) return cached

      let scope = config.scope
      if (cwd !== undefined) {
        try {
          const declared = await readWorkspaceScope(cwd)
          if (declared) scope = declared
        } catch {
          // A broken workspace file must neither widen the scope nor break the turn.
        }
      }
      resolved.set(agentId, scope)
      return scope
    },
    clear(agentId) {
      resolved.delete(agentId)
    },
  }
}
