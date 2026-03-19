import { existsSync, readFileSync, writeFileSync } from 'fs'
import yaml from 'js-yaml'
import type { Episode } from './schemas/episode.js'
import type { CaptureContext, TimelineQuery } from './types.js'

function generateEpisodeId(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `EP-${ts}-${rand}`
}

export function captureEpisode(path: string, summary: string, context?: CaptureContext): Episode {
  const episodes = loadEpisodes(path)
  const episode: Episode = {
    id: generateEpisodeId(),
    summary,
    agent: context?.agent,
    channel: context?.channel,
    session_id: context?.session_id,
    tags: context?.tags,
    timestamp: new Date().toISOString(),
  }
  episodes.push(episode)
  writeFileSync(path, yaml.dump(episodes, { lineWidth: 120, noRefs: true }), 'utf8')
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

function loadEpisodes(path: string): Episode[] {
  if (!existsSync(path)) return []
  try {
    const raw = yaml.load(readFileSync(path, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}
