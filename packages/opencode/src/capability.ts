/**
 * Which injection path is live.
 *
 * `experimental.chat.system.transform` is the preferred path because it does
 * not accrete. It is also an experimental API on a package that ships almost
 * daily. If a full turn passes and it never fired, the host no longer supports
 * it — latch to the `chat.message` fallback, which accretes but works.
 *
 * The turn boundary (`markTurn`) is evaluated lazily, on the next
 * `shouldFallback()` read, against whatever rendering happened since the
 * previous evaluation — not eagerly inside `markTurn()` itself. That matters
 * for two reasons: it tolerates `markRendered()` arriving either before or
 * after the `markTurn()` call for the same turn, and it resets the
 * per-turn render flag after each evaluation so a regression that starts
 * mid-session (after earlier turns rendered fine) is still detected instead
 * of being masked by a stale "it rendered once" flag.
 */
export class RenderPath {
  private renderedThisTurn = false
  private turnPending = false
  private latched = false

  markRendered(): void { this.renderedThisTurn = true }
  markTurn(): void { this.turnPending = true }

  shouldFallback(): boolean {
    if (this.turnPending) {
      this.turnPending = false
      if (!this.renderedThisTurn) this.latched = true
      this.renderedThisTurn = false
    }
    return this.latched
  }
}
