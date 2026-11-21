/**
 * Which injection path is live, tracked per session: opencode runs several
 * sessions per process, and shared state would let one session's `session.idle`
 * consume another's render flag. `experimental.chat.system.transform` is
 * preferred (does not accrete); if a full turn passes without it, latch to the
 * accreting `chat.message` fallback. Turns are evaluated lazily on the next
 * `shouldFallback()` and reset the per-turn flag, so render/turn order does not
 * matter and mid-session regressions are caught. `markRendered()` clears the
 * latch, so recovery needs no restart.
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
