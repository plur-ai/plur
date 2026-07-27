/**
 * Per-session default write scope (convergence Phase 2 — concurrency
 * correctness).
 *
 * ### The defect this replaces
 *
 * `Plur` held the session default in a single instance field, `_sessionScope`,
 * set by `setSessionScope()` and read by `_guardSensitiveScope()` on every
 * unscoped write. One field, one instance, every caller.
 *
 * That is safe under exactly one condition: one session per `Plur` instance,
 * executing without interleaving. Neither half holds any more. `learnRouted()`
 * is already `async` and already awaits a network round-trip between reading
 * the session scope and persisting the engram, and a deployment that serves
 * several concurrent sessions from one instance — which is the whole point of
 * the convergence work — has several sessions racing on that field. The
 * failure is silent and directional: session B calls `setSessionScope('B')`
 * while session A is mid-`learnRouted`, and A's engram lands in B's scope. A
 * write crossing a scope boundary is precisely the outcome scoping exists to
 * prevent.
 *
 * ### The shape
 *
 * `packages/claw/src/context-engine.ts` already runs one shared `Plur` across
 * concurrent sessions and solves this the only way it can be solved: a
 * `Map<sessionKey, scope>` plus explicit threading of the scope into each call.
 * This class is that map, moved into core so every consumer gets it rather than
 * each re-deriving it.
 *
 * ### Resolution order
 *
 * A session that has registered a scope gets its own — always, regardless of
 * what any other session does. A session that has NOT registered one inherits
 * the process-default slot, which is what the single-session CLI and MCP
 * deployments use and what `setSessionScope(scope)` without a key still sets.
 * So the existing single-session behaviour is byte-for-byte unchanged, and
 * isolation is opt-in per session by registering.
 *
 * Registering `null` for a session is meaningful and distinct from not
 * registering: it pins that session to "no session scope", so unscoped writes
 * auto-route instead of inheriting the process default.
 */

export class SessionScopeRegistry {
  private scopes = new Map<string, string | null>()
  private defaultScope: string | null = null

  /**
   * Set the default write scope for `session`, or for the process when
   * `session` is omitted.
   *
   * `null` means "no session scope": unscoped writes in that session fall to
   * auto-routing. For a keyed session that is distinct from never having
   * registered — see the module header.
   */
  set(scope: string | null, session?: string): void {
    if (session === undefined) {
      this.defaultScope = scope
      return
    }
    this.scopes.set(session, scope)
  }

  /**
   * Resolve the default write scope for `session`. Falls back to the process
   * slot only when the session has no registration of its own.
   */
  get(session?: string): string | null {
    if (session !== undefined && this.scopes.has(session)) {
      return this.scopes.get(session) ?? null
    }
    return this.defaultScope
  }

  /**
   * Forget a session's registration. Call on session end — a long-lived
   * deployment would otherwise retain one entry per session it has ever seen.
   * Omitting `session` clears the process slot.
   */
  clear(session?: string): void {
    if (session === undefined) {
      this.defaultScope = null
      return
    }
    this.scopes.delete(session)
  }

  /** Sessions with their own registration. Diagnostic / test seam. */
  get trackedSessions(): string[] {
    return [...this.scopes.keys()]
  }
}
