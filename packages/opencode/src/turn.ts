/**
 * Assistant text accumulated for the current turn, per session. About
 * `message.part.updated` (see `scripts/probes/opencode-plugin-probe.mjs`):
 * 1. **Updates are cumulative snapshots, not deltas**, so `append` is keyed by
 *    part id and the latest text wins.
 * 2. **It also fires for the user's own message part**; `markUserMessage`
 *    records that messageID so `append` excludes it from the parser input.
 * `session.idle` fires more than once per turn, so the take is one-shot: the
 * buffer is stale until the next turn appends (no duplicate engram writes).
 */
export class TurnBuffer {
  private parts = new Map<string, Map<string, string>>() // sessionID -> partID -> latest text
  private fresh = new Map<string, boolean>()
  private userMessage = new Map<string, string>() // sessionID -> that session's current user messageID
  /**
   * Part ids already handed out by `takeIfFresh` this turn. Updates are
   * cumulative snapshots, and one can arrive after the take (the second
   * `session.idle`, a late stream flush); re-arming `fresh` with it would learn
   * the transcript twice. A taken part is closed; the set resets when the next
   * turn's user message arrives.
   */
  private taken = new Map<string, Set<string>>()

  /** Record the messageID of the user's own turn message, so `append` can exclude its parts. */
  markUserMessage(sessionID: string, messageID: string | undefined): void {
    if (!messageID) return
    if (this.userMessage.get(sessionID) !== messageID) this.taken.delete(sessionID)
    this.userMessage.set(sessionID, messageID)
  }

  append(sessionID: string, partID: string, messageID: string | undefined, text: string): void {
    if (!text) return
    if (messageID && this.userMessage.get(sessionID) === messageID) return
    if (this.taken.get(sessionID)?.has(partID)) return
    const byPart = this.parts.get(sessionID) ?? new Map<string, string>()
    byPart.set(partID, text)
    this.parts.set(sessionID, byPart)
    this.fresh.set(sessionID, true)
  }

  takeIfFresh(sessionID: string): string[] | undefined {
    if (!this.fresh.get(sessionID)) return undefined
    const byPart = this.parts.get(sessionID)
    if (!byPart || byPart.size === 0) return undefined
    this.fresh.set(sessionID, false)
    const taken = this.taken.get(sessionID) ?? new Set<string>()
    for (const id of byPart.keys()) taken.add(id)
    this.taken.set(sessionID, taken)
    this.parts.set(sessionID, new Map())
    return [...byPart.values()]
  }

  clear(sessionID: string): void {
    this.parts.delete(sessionID)
    this.fresh.delete(sessionID)
    this.userMessage.delete(sessionID)
    this.taken.delete(sessionID)
  }
}
