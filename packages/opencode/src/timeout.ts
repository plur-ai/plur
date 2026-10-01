/**
 * Upper bound on the recall in `chat.message` (formal R2, mcp#10). The recall
 * was awaited unbounded, so a hung store (lock, dead remote, stuck embedder)
 * stalled the user's turn. Past the bound the turn proceeds with no memory
 * block; the recall keeps running in the background and its result is dropped.
 * 10 s leaves room for the embedder's cold load.
 */
export const INJECT_TIMEOUT_MS = 10_000
