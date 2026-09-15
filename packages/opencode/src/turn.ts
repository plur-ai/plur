/**
 * Assistant text accumulated for the current turn, per session.
 *
 * `session.idle` fires more than once per turn (measured: twice), so the take
 * is one-shot — the buffer goes stale after a take and only becomes fresh
 * again when the next turn appends text. Without this the learner runs twice
 * over one transcript and writes the same engram twice.
 */
export class TurnBuffer {
  private buf = new Map<string, string[]>()
  private fresh = new Map<string, boolean>()

  append(sessionID: string, text: string): void {
    if (!text) return
    const arr = this.buf.get(sessionID) ?? []
    arr.push(text)
    this.buf.set(sessionID, arr)
    this.fresh.set(sessionID, true)
  }

  takeIfFresh(sessionID: string): string[] | undefined {
    if (!this.fresh.get(sessionID)) return undefined
    const arr = this.buf.get(sessionID)
    if (!arr || arr.length === 0) return undefined
    this.fresh.set(sessionID, false)
    this.buf.set(sessionID, [])
    return arr
  }

  clear(sessionID: string): void { this.buf.delete(sessionID); this.fresh.delete(sessionID) }
}
