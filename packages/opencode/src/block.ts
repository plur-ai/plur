/**
 * The rendered memory block for each live session.
 *
 * Written once per user turn by the recall trigger; read on every model
 * request by the renderer. Overwrite, never append — the whole point of the
 * system-prompt path is that it does not accrete.
 */
export class BlockCache {
  private blocks = new Map<string, string>()

  set(sessionID: string, block: string): void { this.blocks.set(sessionID, block) }
  get(sessionID: string): string | undefined { return this.blocks.get(sessionID) }
  clear(sessionID: string): void { this.blocks.delete(sessionID) }
  clearAll(): void { this.blocks.clear() }
}
