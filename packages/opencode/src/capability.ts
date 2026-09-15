/**
 * Which injection path is live, tracked per session — consistent with
 * `BlockCache`/`TurnBuffer`, and for the same reason: opencode can run
 * multiple sessions in one process, and a single shared instance let one
 * session's `session.idle` consume the render flag another session's
 * `system.transform` had just set, latching the accreting fallback for
 * every session over one unlucky interleave.
 *
 * `experimental.chat.system.transform` is the preferred path because it does
 * not accrete. It is also an experimental API on a package that ships almost
 * daily. If a full turn passes and it never fired, the host no longer supports
 * it — latch to the `chat.message` fallback, which accretes but works.
 *
 * The turn boundary (`markTurn`) is evaluated lazily, on the next
 * `shouldFallback()` read for that session, against whatever rendering
 * happened since the previous evaluation — not eagerly inside `markTurn()`
 * itself. That matters for two reasons: it tolerates `markRendered()`
 * arriving either before or after the `markTurn()` call for the same turn,
 * and it resets the per-turn render flag after each evaluation so a
 * regression that starts mid-session (after earlier turns rendered fine) is
 * still detected instead of being masked by a stale "it rendered once" flag.
 *
 * The latch is self-healing: `markRendered()` clears it, so a session that
 * starts rendering again (opencode ships a fix, a turn reaching `session.idle`
 * without ever building a model request stops recurring, etc.) leaves the
 * fallback on its own — recovery no longer needs an opencode restart.
 * Detection is preserved: a genuinely dead `system.transform` never calls
 * `markRendered()`, so it stays latched.
 */
interface SessionRenderState {
  renderedThisTurn: boolean
  turnPending: boolean
  latched: boolean
}

export class RenderPath {
  private sessions = new Map<string, SessionRenderState>()

  private state(sessionID: string): SessionRenderState {
    let s = this.sessions.get(sessionID)
    if (!s) {
      s = { renderedThisTurn: false, turnPending: false, latched: false }
      this.sessions.set(sessionID, s)
    }
    return s
  }

  markRendered(sessionID: string): void {
    const s = this.state(sessionID)
    s.renderedThisTurn = true
    // Self-healing: rendering happened, so this session no longer needs the
    // accreting fallback. Non-sticky in the failing direction only — a
    // session that never renders never reaches this line, so it stays
    // latched.
    s.latched = false
  }

  markTurn(sessionID: string): void {
    this.state(sessionID).turnPending = true
  }

  shouldFallback(sessionID: string): boolean {
    const s = this.state(sessionID)
    if (s.turnPending) {
      s.turnPending = false
      if (!s.renderedThisTurn) s.latched = true
      s.renderedThisTurn = false
    }
    return s.latched
  }

  /** Drop a session's state — called on `session.deleted`, like BlockCache/TurnBuffer. */
  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}
