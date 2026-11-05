/**
 * Per-session default write scope: a `Map<sessionKey, scope>`, because `learnRouted()` awaits the network between
 * reading the scope and persisting, so one instance-wide scope would let concurrent sessions write into each
 * other's scope.
 * A session with a registered scope gets its own; an unregistered one inherits the process-default slot (what
 * `setSessionScope(scope)` without a key sets). Registering `null` pins "no session scope", so unscoped writes
 * auto-route instead of inheriting the default.
 */

/**
 * The "no session" sentinel, for `LearnContext.session`, `RecallOptions.session` or `InjectOptions.session_id` when
 * the caller KNOWS it has no session: the registry answers `null`, so an unscoped write takes the unscoped path
 * (auto-route / `unscoped_default`) instead of the last-set process default. An explicit `scope` still wins.
 * No real session id can collide with it; it is never registered, recorded in provenance or persisted.
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
