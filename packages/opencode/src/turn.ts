/**
 * Assistant text accumulated for the current turn, per session.
 *
 * Two properties of `message.part.updated`, confirmed against the real
 * opencode 1.18.30 binary (repo probe, `scripts/probes/opencode-plugin-probe.mjs`,
 * logging part id + head/tail per update):
 *
 * 1. **Updates are cumulative snapshots of one part, not deltas.** The same
 *    part id arrives repeatedly with growing text (`""` -> `"1"` ->
 *    `"1\n2\n3..."`). `append` is therefore keyed by part id, latest text
 *    wins — a blind push-per-event would store every intermediate snapshot,
 *    risking the `🧠 I learned:` marker appearing both truncated and
 *    complete in the same joined buffer.
 * 2. **The event also fires for the user's own submitted message part**, not
 *    just the assistant's streamed response. `markUserMessage` records which
 *    messageID belongs to the current turn's user message so `append` can
 *    exclude its parts — otherwise the user's prompt text would be captured
 *    as "assistant text" and fed to the self-report parser every turn.
 *
 * `session.idle` fires more than once per turn (measured: twice), so the take
 * is one-shot — the buffer goes stale after a take and only becomes fresh
 * again when the next turn appends text. Without this the learner runs twice
 * over one transcript and writes the same engram twice.
 */
export class TurnBuffer {
  private parts = new Map<string, Map<string, string>>() // sessionID -> partID -> latest text
  private fresh = new Map<string, boolean>()
  private userMessage = new Map<string, string>() // sessionID -> that session's current user messageID

  /** Record the messageID of the user's own turn message, so `append` can exclude its parts. */
  markUserMessage(sessionID: string, messageID: string | undefined): void {
    if (!messageID) return
    this.userMessage.set(sessionID, messageID)
  }

  append(sessionID: string, partID: string, messageID: string | undefined, text: string): void {
    if (!text) return
    if (messageID && this.userMessage.get(sessionID) === messageID) return
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
    this.parts.set(sessionID, new Map())
    return [...byPart.values()]
  }

  clear(sessionID: string): void {
    this.parts.delete(sessionID)
    this.fresh.delete(sessionID)
    this.userMessage.delete(sessionID)
  }
}
