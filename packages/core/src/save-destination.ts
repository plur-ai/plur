import type { LearnDelivery } from './index.js'
import type { GitScopeOutcome, LocalReason, UnknownReason } from './git-origin.js'
import type { DiscoveryStatus } from './server-discovery.js'
import { ENTERPRISE_SETUP_COMMAND } from './enterprise.js'
import { collapseLineTerminators } from './sanitize.js'

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

export interface ServerSessionState {
  host: string
  username?: string
  status: DiscoveryStatus | 'never'
  target: GitScopeOutcome | { kind: 'map'; scope: string } | null
  queued?: { count: number; since: string; needsAction: boolean; reason?: string }
  keyExpiresAt?: string | null
  now?: number
  /** A configured destination that cannot accept writes. */
  writeWarning?: string
}

/** Cached status only: no probe, token, raw server error or memory text. */
export function formatServerSessionLine(s: ServerSessionState): string {
  const name = s.username ? ` as ${collapseLineTerminators(s.username).slice(0, 80)}` : ''
  let line = `PLUR → server${name} · `
  const target = s.target
  const retained = s.writeWarning ? ` — ${s.writeWarning}`
    : target?.kind === 'scope' || target?.kind === 'map'
      ? ` — saves still target ${target.scope}; delivery may be queued` : ' — saving on this laptop only'
  if (s.status === 'not_synced') {
    line += "⚠ your account is not on the server's member list yet" + retained
  } else if (s.status === 'auth_failed') {
    line += `⚠ the server rejected your key${retained}; run ${ENTERPRISE_SETUP_COMMAND} again`
  } else if (s.writeWarning) {
    line += `⚠ ${s.writeWarning}`
  } else if (target?.kind === 'unknown') {
    line += `⚠ could not tell where saves go (${unknownReasons[target.reason]}) — saving on this laptop only`
  } else if (target?.kind === 'scope' || target?.kind === 'map') {
    line += `saving to ${target.scope}`
  } else if (target?.kind === 'local') {
    line += `saving on this laptop only — ${localReasons[target.reason]}`
  } else {
    line += 'saving on this laptop only'
  }
  if (s.queued && s.queued.count > 0) {
    const q = s.queued
    line += ` · ${q.count} ${q.count === 1 ? 'save' : 'saves'} waiting since ${q.since} — `
    line += q.needsAction
      ? `${q.reason ?? 'key rejected'}; run ${ENTERPRISE_SETUP_COMMAND} again`
      : 'server unreachable; they retry automatically'
  }
  if (s.keyExpiresAt !== null) {
    const expires = s.keyExpiresAt === undefined ? NaN : Date.parse(s.keyExpiresAt)
    const remaining = expires - (s.now ?? Date.now())
    if (!Number.isFinite(expires)) line += ' · key expiry unknown'
    else if (remaining <= 0) line += ` · key expired ${new Date(expires).toISOString().slice(0, 10)} — run ${ENTERPRISE_SETUP_COMMAND} again`
    else if (remaining <= 14 * 86_400_000) line += ` · key expires in ${Math.ceil(remaining / 86_400_000)} days`
  }
  if (target?.kind === 'local' && s.status === 'ok') line += ' — to share it: plur folders set . --scope <scope>'
  return line
}
