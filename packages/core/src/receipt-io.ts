import { readCoInjections } from './history.js'
import { computeReceipt, type Receipt } from './receipt.js'

/**
 * Assemble a Receipt from what is on disk. Kept separate from computeReceipt so
 * the arithmetic stays pure and filesystem-free.
 *
 * `ownIds` and `packIds` must come from LOCAL sources only (the primary store
 * YAML and the packs directory), never the remote-store cache: the cache is
 * empty on the first call in a cold CLI process but warm in the long-lived MCP
 * server, which would make the same command report two different numbers.
 * `externalPrefixes` lets the pure function tell a team-store retrieval apart
 * from a genuinely deleted engram.
 */
export function gatherReceipt(
  root: string,
  ownIds: string[],
  packIds: string[],
  externalPrefixes: string[],
  opts: { days?: number; now?: Date } = {},
): Receipt {
  let events
  try {
    ({ events } = readCoInjections(root))
  } catch {
    // A missing or unreadable history directory means "no data yet", never a
    // crash — the receipt is a read-only report and must degrade gracefully.
    events = []
  }
  return computeReceipt({
    ownEngramIds: ownIds,
    packEngramIds: packIds,
    events,
    now: opts.now ?? new Date(),
    days: opts.days,
    externalIdPrefixes: externalPrefixes,
  })
}
