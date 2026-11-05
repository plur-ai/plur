import { existsSync, readFileSync } from 'fs'
import yaml from 'js-yaml'
import type { Episode } from './schemas/episode.js'
import type { CaptureContext, TimelineQuery } from './types.js'
import { withLock } from './file-lock.js'
import { atomicWrite } from './atomic-write.js'
import { parseRecordArrayFile } from './engrams.js'

function generateEpisodeId(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `EP-${ts}-${rand}`
}

/**
 * Append one episode to the episode log. The load-push-write runs under a lock
 * keyed on the episodes path (several MCP servers may capture at once, and the
 * write replaces the whole array); the load MUST stay inside it. Nothing else
 * takes this lock, so it cannot deadlock with the store lock, and the
 * synchronous `withLock` is safe because no async holder ever takes it.
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
 * Never returns `[]` for a corrupt or wrongly-shaped file: `captureEpisode`
 * rewrites the whole array, so the next capture would overwrite everything.
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
