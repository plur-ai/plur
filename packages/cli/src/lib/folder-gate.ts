import { existsSync, mkdirSync, writeFileSync, readSync } from 'fs'
import { basename, dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  resolveFolderPolicy,
  issueFolderNonce,
  loadConfig,
  findProjectConfigPath,
  canonicalize,
  type FolderPolicy,
  type Plur,
} from '@plur-ai/core'
import { isPlurConfigured } from './plur-configured.js'
import { safeSessionKey } from './session-key.js'

/**
 * The folder map in the editor hooks (#1347, design r2 "Resolution" and
 * "The ask"). Every hook asks one question first — what has the user decided
 * about this folder? — and this module answers it, replacing the old
 * `isPlurConfigured()` gate:
 *
 *   - `on`  → the hook works as it always did. The policy's `scope` (a map
 *             entry's scope, else a trusted `.plur.yaml`'s hint) is the
 *             session scope, which is also what makes core dial the team
 *             store that scope belongs to.
 *   - `off` → the hook is silent and does nothing at all.
 *   - `ask` → the hook is silent, except the prompt-level inject hook of each
 *             editor, which on the first prompt of a session emits the one
 *             question built by {@link folderAskOnce} instead of memories.
 *
 * Only the CLI (`plur folders set`) writes the map; nothing here writes it.
 */

/** The PLUR home the hooks read the map from: `--path`, else PLUR_PATH, else ~/.plur. */
export function plurRoot(flags?: { path?: string }): string {
  return flags?.path ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
}

/**
 * The folder a hook payload is about: its `cwd` when the editor sends one that
 * exists, else process.cwd() (the folder the editor started the hook in).
 */
export function payloadDir(input: Record<string, unknown> | null | undefined): string {
  const cwd = input?.cwd
  return typeof cwd === 'string' && cwd && existsSync(cwd) ? cwd : process.cwd()
}

/**
 * The folder policy for `dir`. A resolver failure must never break a hook, and
 * must not switch memory on where it was off before: it falls back to the old
 * gate (a project marker means on), otherwise to a silent `ask`.
 */
export function hookFolderPolicy(dir: string, flags?: { path?: string }): FolderPolicy {
  try {
    return resolveFolderPolicy(dir, { root: plurRoot(flags) })
  } catch (err) {
    process.stderr.write(`[plur] folder map: could not resolve ${dir} (${(err as Error)?.message ?? err}); using the project marker.\n`)
    return isPlurConfigured(dir)
      ? { mode: 'on', remoteAllowed: false, source: 'plur-yaml' }
      : { mode: 'ask', remoteAllowed: false, source: 'default' }
  }
}

/** True when the hooks should do their normal work in `dir`. */
export function hookFolderOn(dir: string, flags?: { path?: string }): boolean {
  return hookFolderPolicy(dir, flags).mode === 'on'
}

/**
 * The scope and domain a session in this folder uses. The scope is the
 * policy's; the `.plur.yaml` domain applies only when the policy came from that
 * `.plur.yaml` (trusted, or requesting nothing), the same rule the resolver
 * applies to its scope (decision D1).
 */
export function sessionSettings(
  policy: FolderPolicy,
  config: { domain?: string },
): { scope?: string; domain?: string } {
  return {
    ...(policy.scope ? { scope: policy.scope } : {}),
    ...(policy.source === 'plur-yaml' && config.domain ? { domain: config.domain } : {}),
  }
}

function askedPath(sessionId: string): string {
  return join(tmpdir(), 'plur-sessions', `${safeSessionKey(sessionId)}.folder-asked`)
}

/**
 * Record that this session has been asked. True the first time, false after.
 * An unwritable temp dir answers true (the question may then repeat, which is
 * noisy but honest; never asking would hide the folder's state).
 */
function claimAsk(sessionId: string): boolean {
  const path = askedPath(sessionId)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(Date.now()), { flag: 'wx' })
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'EEXIST'
  }
}

/** A folder path as a shell argument that works in sh, cmd and PowerShell. */
function quoted(p: string): string {
  return /^[A-Za-z0-9_./:\\~-]+$/.test(p) ? p : `"${p}"`
}

function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

/**
 * Scopes this install can write to that are worth offering: configured stores
 * that are not readonly. The suggestion is the repo's requested scope when it
 * is one of them, else the best match of the scope ranker over them. Never a
 * scope that is not configured, so a "yes" can never route memory to a store
 * the user did not set up.
 */
function suggestScopes(
  plur: Plur | null,
  root: string,
  folder: string,
  prompt: string,
  requested: FolderPolicy['requested'],
): { suggested?: string; others: string[] } {
  let writable: string[] = []
  try {
    const stores = loadConfig(join(root, 'config.yaml')).stores ?? []
    writable = [...new Set(stores.filter(s => s.readonly !== true).map(s => s.scope))]
  } catch { /* no config: nothing to offer */ }
  if (writable.length === 0) return { others: [] }
  let suggested: string | undefined
  if (requested?.scope && writable.includes(requested.scope)) suggested = requested.scope
  if (!suggested && plur) {
    try {
      const ranked = plur.suggestScope({
        statement: `${basename(folder)} ${prompt.slice(0, 300)}`,
        ...(requested?.domain ? { domain: requested.domain } : {}),
      })
      suggested = ranked.find(c => writable.includes(c.scope))?.scope
    } catch { /* ranking is advisory */ }
  }
  // One configured scope and nothing ranked: that one is the obvious offer.
  // It is only offered; the user still picks the answer.
  if (!suggested && writable.length === 1) suggested = writable[0]
  return { ...(suggested ? { suggested } : {}), others: writable.filter(s => s !== suggested).slice(0, 5) }
}

export interface FolderAskOptions {
  dir: string
  policy: FolderPolicy
  /** The editor's session / conversation id. No id, no question: the nonce and the asked-once record need it. */
  sessionId: string
  flags?: { path?: string }
  plur?: Plur | null
  prompt?: string
}

/**
 * The one-time question for an `ask` folder, or null when this session has
 * already been asked (or has no id). Issues a single-use nonce for exactly
 * the folder asked about; `plur folders set` accepts only that.
 *
 * The folder is the one the decision is about: the directory holding an
 * untrusted `.plur.yaml`, otherwise the working folder.
 */
export function folderAskOnce(opts: FolderAskOptions): string | null {
  if (!opts.sessionId) return null
  if (!claimAsk(opts.sessionId)) return null

  const root = plurRoot(opts.flags)
  const untrusted = opts.policy.reason === 'untrusted-plur-yaml'
  const configPath = untrusted ? findProjectConfigPath(opts.dir) : null
  const folder = canonicalize(configPath ? dirname(configPath) : opts.dir)
  let nonce: string
  try {
    nonce = issueFolderNonce(root, opts.sessionId, folder)
  } catch (err) {
    process.stderr.write(`[plur] folder map: could not issue a nonce (${(err as Error)?.message ?? err}).\n`)
    return null
  }
  const { suggested, others } = suggestScopes(opts.plur ?? null, root, folder, opts.prompt ?? '', opts.policy.requested)
  const f = quoted(folder)
  const set = (what: string) => `plur folders set ${f} ${what} --nonce ${nonce}`

  const lines: string[] = []
  if (untrusted) {
    const req = opts.policy.requested ?? {}
    const asks: string[] = []
    if (req.scope) asks.push(`the scope ${req.scope}`)
    if (req.domain) asks.push(`the domain ${req.domain}`)
    if (req.remote_url) asks.push(`sending memories to ${hostOf(req.remote_url)}`)
    lines.push(
      `[PLUR Memory — this repo's .plur.yaml is not trusted, so no memories were loaded] ` +
      `${folder}/.plur.yaml asks for ${asks.join(', ') || 'project settings'}. None of it is used until the user allows it.`,
      'Before you continue, ask the user once whether to use PLUR here, and run the command for their answer:',
      `- Yes, and trust this repo's .plur.yaml: ${set('--trusted')}`,
      `- Yes, without its settings: ${set(suggested ? `--scope ${suggested}` : '--on')}`,
    )
  } else {
    lines.push(
      `[PLUR Memory — no decision for this folder yet, so no memories were loaded] ${folder}`,
      'Before you continue, ask the user once whether to use PLUR memory in this folder, and run the command for their answer:',
      suggested
        ? `- Yes: ${set(`--scope ${suggested}`)} (or ${set('--on')} without a team scope)`
        : `- Yes: ${set('--on')}`,
    )
  }
  lines.push(
    '- Not now: run nothing. This session will not ask again.',
    `- Never here: ${set('--off')}`,
  )
  if (others.length > 0) lines.push(`Other team scopes configured here: ${others.join(', ')} (use one with --scope instead).`)
  lines.push(
    'The nonce works once, only for this folder. Run nothing without the user\'s answer. ' +
    'After a yes, memory loads from the next prompt.',
  )
  return lines.join('\n')
}

/** The raw hook payload on stdin ('' when there is none). */
export function readStdinRaw(): string {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    for (;;) {
      let n = 0
      try { n = readSync(0, buf, 0, buf.length, null) } catch { break }
      if (n === 0) break
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

/** The payload as an object; {} when it is missing or not JSON. */
export function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = raw.trim() ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** True when `text` is (or holds) the question folderAskOnce builds. */
export function isFolderAskText(text: string): boolean {
  return /\[PLUR Memory — (no decision for this folder yet|this repo's \.plur\.yaml is not trusted)/.test(text)
}
