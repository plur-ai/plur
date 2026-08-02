import { existsSync, readFileSync } from 'fs'
import yaml from 'js-yaml'
import type { Episode } from './schemas/episode.js'
import type { CaptureContext, TimelineQuery } from './types.js'
import { atomicWrite, withLock } from './sync.js'
import { parseRecordArrayFile } from './engrams.js'

function generateEpisodeId(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `EP-${ts}-${rand}`
}

/**
 * Append one episode to the episode log.
 *
 * ## Why the lock (audit #794, F8)
 *
 * This was load -> push -> write with no mutual exclusion of any kind, while
 * being reachable from `plur_capture`, `plur_session_end` and `reportFailure` —
 * i.e. from every MCP server the user has open at once. Since the write
 * replaces the whole array, a concurrent capture did not interleave, it
 * overwrote: probe P02 ran 4 processes x 25 episodes and **30 of 100
 * survived**.
 *
 * The lock is keyed on the episodes path, which nothing else locks, so it
 * cannot contend with (or deadlock against) the engram store lock. The load
 * MUST stay inside it — locking only the write leaves the same race, just
 * narrower.
 *
 * `withLock` is the synchronous variant because this function is synchronous
 * and has synchronous callers. That is safe HERE specifically because no async
 * holder ever takes this path's lock, so the busy-wait cannot starve one out
 * (the failure mode measured as F10 on the store lock).
 */
export function captureEpisode(path: string, summary: string, context?: CaptureContext): Episode {
  const episode: Episode = {
    id: generateEpisodeId(),
    summary,
    agent: context?.agent,
    channel: context?.channel,
    session_id: context?.session_id,
    tags: context?.tags,
    timestamp: new Date().toISOString(),
  }
  withLock(path, () => {
    // Quarantined records ride along so a malformed episode is withheld from
    // queries without being deleted by the next capture.
    const { valid, quarantined } = loadEpisodesWithQuarantine(path)
    const out = [...valid, episode, ...(quarantined as Episode[])]
    atomicWrite(path, yaml.dump(out, { lineWidth: 120, noRefs: true }))
  })
  return episode
}

export function queryTimeline(path: string, query?: TimelineQuery): Episode[] {
  let episodes = loadEpisodes(path)
  if (query?.since) episodes = episodes.filter(e => new Date(e.timestamp) >= query.since!)
  if (query?.until) episodes = episodes.filter(e => new Date(e.timestamp) <= query.until!)
  if (query?.agent) episodes = episodes.filter(e => e.agent === query.agent)
  if (query?.channel) episodes = episodes.filter(e => e.channel === query.channel)
  if (query?.search) {
    const terms = query.search.toLowerCase().split(/\s+/)
    episodes = episodes.filter(e => terms.some(t => e.summary.toLowerCase().includes(t)))
  }
  return episodes
}

/**
 * Read the episode log, or throw when it is unreadable.
 *
 * Returned `[]` for a corrupt or wrongly-shaped file until the #811 audit —
 * and since `captureEpisode` rewrites the whole array, the next capture then
 * wrote a one-episode file over everything. Same shape as the engram-store
 * wipe (#794 F1), in an artifact the original sweep listed but never fixed.
 */
function loadEpisodesWithQuarantine(path: string): { valid: Episode[]; quarantined: unknown[] } {
  return parseRecordArrayFile<Episode>(path, entry =>
    // Episodes have no Zod schema; the shape contract is an object with an id.
    entry !== null && typeof entry === 'object' && typeof (entry as Episode).id === 'string'
      ? entry as Episode
      : null,
  )
}

function loadEpisodes(path: string): Episode[] {
  return loadEpisodesWithQuarantine(path).valid
}
