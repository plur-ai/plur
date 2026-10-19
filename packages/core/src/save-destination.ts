import type { LearnDelivery } from './index.js'
import type { GitScopeOutcome, LocalReason, UnknownReason } from './git-origin.js'

export interface SaveDestinationInput {
  delivery: LearnDelivery
  scope: string
  server?: string
  shared: boolean
  folder?: GitScopeOutcome | null
  unauthorizedOn?: string
  queuedReason?: string
  /** A known local-write reason takes precedence over a folder default. */
  localReason?: string
}

const localReasons: Record<LocalReason, string> = {
  'no-remote': 'this repo has no origin remote',
  'not-company-gitlab': 'this repo is not on the company GitLab',
  'no-scope-for-project': 'this repo has no team scope',
}
const unknownReasons: Record<UnknownReason, string> = {
  'git-unreadable': 'git could not be read',
  'scopes-unavailable': "the server's scope list is unavailable",
  'cache-stale': 'the scope list is out of date',
  'ambiguous-mapping': 'two scopes claim this project',
}

/** Describe actual delivery; a configured server is never evidence of a save. */
export function formatSaveDestination(i: SaveDestinationInput): string {
  if (i.delivery === 'remote') return `saved to ${i.scope} (server)`
  if (i.delivery === 'outbox') return `queued for ${i.scope} — not on the server yet: ${i.queuedReason ?? 'waiting to be sent'}`
  const local = 'saved on this laptop only'
  if (i.unauthorizedOn) return `${local} — ${i.scope} is not granted to you on ${i.unauthorizedOn}`
  if (i.localReason) return `${local} — ${i.localReason}`
  // An explicit shared target is not explained by an unrelated repo default.
  if (i.shared) return `${local} — no server store for ${i.scope}`
  if (i.folder?.kind === 'local') return `${local} — ${localReasons[i.folder.reason]}`
  if (i.folder?.kind === 'unknown') return `${local} — could not tell this repo's team scope (${unknownReasons[i.folder.reason]})`
  return local
}
