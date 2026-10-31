/**
 * Per-session default write scope.
 *
 * A single instance-wide session scope is only safe with one session per
 * `Plur` instance and no interleaving. `learnRouted()` awaits a network
 * round-trip between reading the session scope and persisting the engram, so
 * with several concurrent sessions on one instance, session B could change the
 * scope while A is mid-write and A's engram would land in B's scope. This
 * registry keeps a `Map<sessionKey, scope>` so each session's scope is isolated.
 *
 * ### Resolution order
 *
 * A session that has registered a scope gets its own, regardless of what any
 * other session does. A session that has NOT registered one inherits the
 * process-default slot, which is what single-session CLI and MCP deployments
 * use and what `setSessionScope(scope)` without a key sets. Isolation is
 * opt-in per session by registering.
 *
 * Registering `null` for a session is meaningful and distinct from not
 * registering: it pins that session to "no session scope", so unscoped writes
 * auto-route instead of inheriting the process default.
 */

/**
 * The "no session" sentinel.
 *
 * Pass it as `LearnContext.session` (learn / learnRouted), `RecallOptions.session`
 * or `InjectOptions.session_id` when the caller KNOWS it has no session, e.g. an
 * MCP call without a `session_id` while several sessions are open, where
 * falling back to the process-default slot would hand this write whichever
 * session scope was set last (possibly a team scope). With `NO_SESSION` the
 * registry answers `null`: neither a keyed registration nor the process-default
 * slot applies, so an unscoped write takes the genuinely-unscoped path
 * (auto-route / `unscoped_default`, `scope_source` 'routed' | 'default'). An
 * explicit `scope` still wins.
 *
 * It is a string (the `session` fields are strings) that no real session id
 * can collide with. It is never registered (`set` refuses it), never recorded
 * as a session id in provenance, and never persisted on an engram.
 */
export const NO_SESSION = '\u0000plur:no-session'

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
    if (session === NO_SESSION) {
      // A registration under the sentinel could never be read back (`get`
      // answers null for it) — refuse loudly rather than store a dead entry.
      throw new Error('NO_SESSION cannot hold a session scope: it means "no session". Register under a real session key.')
    }
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
    // The sentinel has no default at all, not even the process slot.
    if (session === NO_SESSION) return null
    if (session !== undefined && this.scopes.has(session)) {
      return this.scopes.get(session) ?? null
    }
    return this.defaultScope
  }

  /**
   * The session's OWN registration only, never the process slot. `null` for
   * no session, `NO_SESSION`, or a session that never registered. Used where
   * an inherited process default must not count as the caller's choice (e.g.
   * the personal `user:` remote dial).
   */
  own(session?: string): string | null {
    if (session === undefined || session === NO_SESSION) return null
    return this.scopes.get(session) ?? null
  }

  /**
   * Forget a session's registration. Call on session end — a long-lived
   * deployment would otherwise retain one entry per session it has ever seen.
   * Omitting `session` clears the process slot.
   */
  clear(session?: string): void {
    if (session === NO_SESSION) return
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
