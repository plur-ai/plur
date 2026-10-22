/**
 * What `plur login` (commands/login.ts) and the one-time config.json move
 * (enterprise/legacy-login.ts) share (#1638): the server origin rule, the
 * `/me` probe and the personal scope it gives, the message for a refused
 * takeover of the personal scope, and the owner-only backup of a file that
 * holds a key. Kept apart so neither of those modules imports the other.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { currentWindowsAccount, redactToken, type OwnerOnlyExec, type PersonalScopeTakenError, type ScopeHolder } from '@plur-ai/core'
import { backupWriter } from './backup.js'

export type FetchFn = typeof fetch

/** True for a loopback host, the only place http:// is allowed. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Normalise the host to an origin URL (strips trailing slashes and paths).
 * Rejects http:// for non-localhost hosts — enterprise tokens must not travel over plaintext.
 */
export function normaliseHost(host: string): string {
  let origin: string
  try {
    origin = new URL(host).origin
  } catch {
    // If missing scheme, try prepending https://
    try {
      origin = new URL(`https://${host}`).origin
    } catch {
      throw new Error(`Invalid host: ${host}. Provide a full URL, e.g. https://plur.example.com`)
    }
  }
  if (origin === 'null') throw new Error(`Invalid host: ${host}. Provide a full URL, e.g. https://plur.example.com`)
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw new Error(`Insecure host: ${host}. Use https:// (http:// is only permitted for localhost).`)
  }
  return origin
}

/** A JSON object body, else undefined (never throws). */
export async function readJson(r: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const v = await r.json() as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export type MeAnswer =
  | { status: 'ok'; username: string; orgId: string; scopes: string[] }
  | { status: 'rejected'; httpStatus: number }
  | { status: 'unknown'; reason: string }

/**
 * GET /api/v1/me with the key: who the key belongs to. 401/403 → rejected;
 * a network error, a timeout, another status or an answer without a username
 * and org → unknown. Never throws; the reason never carries the key.
 */
export async function fetchMe(origin: string, key: string, opts: { fetch?: FetchFn; timeoutMs?: number } = {}): Promise<MeAnswer> {
  const f = opts.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000)
  try {
    const r = await f(`${origin}/api/v1/me`, {
      signal: ctrl.signal,
      headers: { 'authorization': `Bearer ${key}`, 'accept': 'application/json' },
    })
    if (r.status === 401 || r.status === 403) return { status: 'rejected', httpStatus: r.status }
    if (!r.ok) return { status: 'unknown', reason: `HTTP ${r.status}` }
    const data = await readJson(r)
    const username = data?.username
    const orgId = data?.org_id
    if (typeof username !== 'string' || !username || typeof orgId !== 'string' || !orgId) {
      return { status: 'unknown', reason: 'the answer names no user and org' }
    }
    const scopes = Array.isArray(data!.scopes) ? (data!.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : []
    return { status: 'ok', username, orgId, scopes }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { status: 'unknown', reason: 'timed out' }
    const code = errorCode(err)
    return { status: 'unknown', reason: code ? `network error (${code})` : 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The system error code of a failed fetch (`ECONNRESET`, `ENOTFOUND`,
 * `UND_ERR_CONNECT_TIMEOUT`), from the error or its cause; only a code-shaped
 * value, never the message (which can quote a server's text).
 */
function errorCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 3; e = e.cause as typeof e, i++) {
    if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(e.code)) return e.code
  }
  return undefined
}

/** The personal scope of a /me answer: the one the server lists for this
 *  user (its own spelling), else `user:<org>:<username>`. */
export function personalScopeOf(me: { username: string; orgId: string; scopes: string[] }): string {
  const want = `user:${me.orgId}:${me.username}`
  return me.scopes.find(s => s.toLowerCase() === want.toLowerCase()) ?? want
}

/** How one registered entry is named to the user: origin or path, scope, readonly. */
export function holderLine(h: ScopeHolder): string {
  const where = h.url ?? (h.path ? `path ${h.path}` : '(an entry without url or path)')
  return `  - ${where} (scope ${h.scope}${h.readonly ? ', read-only' : ''}${h.sameServer ? ', this server\'s own entry' : ''})`
}

/**
 * The message for a refused takeover of the personal scope (owner decision on
 * B5: refuse; the installer offers to remove the stale entry). Names every
 * entry that holds the scope and the command that removes them.
 */
export function takeoverMessage(err: PersonalScopeTakenError, origin: string, configPath: string,
  wording: { lead?: string; notSaved?: string; rerun?: string } = {}): string[] {
  const one = err.holders.length === 1
  const lines = [
    `${wording.lead ?? `Signed in, but ${origin} was not saved:`} your personal scope ${err.personalScope} is already served by`,
    `${one ? 'another entry' : 'other entries'} in ${configPath}:`,
    ...err.holders.map(holderLine),
    `Saving ${origin} would move your personal writes away from ${one ? 'it' : 'them'}. Nothing was changed${wording.notSaved ?? ', and the key from this sign-in was not saved'}.`,
  ]
  if (err.removable) {
    lines.push(
      `To remove ${one ? 'that entry' : 'those entries'} and sign in again (config.yaml is backed up first):`,
      `  plur login ${origin} --remove-stale`,
    )
  } else {
    lines.push(
      `${origin}'s own entry serves your personal scope in another spelling. Remove that spelling from its`,
      `scope, scopes or pinned_scopes in ${configPath}, then ${wording.rerun ?? `run \`plur login ${origin}\` again`}.`,
    )
  }
  return lines
}

/** The host the owner-only protection runs on; tests drive the Windows path. */
export interface BackupHost {
  platform?: NodeJS.Platform
  exec?: OwnerOnlyExec
  account?: string | null
}

/**
 * Copy `source` (a file that holds a key: config.yaml, config.json) to
 * `<root>/backups/<stamp>/<name>` and return the copy's path. The folder and
 * the copy are owner-only from the outset — 0700/0600 on Unix, an owner-only
 * access list on Windows, verified — through the cleanup's backup writer,
 * which uses core's `protectOwnerOnly` (#1631). Throws, leaving no copy with
 * content, when that protection cannot be established.
 */
export function backupSecretFile(root: string, source: string, host: BackupHost = {}): string {
  const dir = join(root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  const write = backupWriter(dir, {
    platform: host.platform ?? process.platform,
    exec: host.exec,
    account: host.account !== undefined ? host.account : currentWindowsAccount(process.env),
  })
  return write(source, readFileSync(source))
}

/**
 * From now on, every console line this process prints is redacted with
 * `key`: core logs some server-supplied text itself (scope names, metadata
 * values), and a server could repeat the key there. Returns the undo.
 */
export function redactConsoleWith(key: string): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const saved = methods.map(m => console[m])
  methods.forEach((m, i) => {
    const orig = saved[i]
    console[m] = (...args: unknown[]) => orig(...args.map(a => (typeof a === 'string' ? redactToken(a, key) : a)))
  })
  return () => { methods.forEach((m, i) => { console[m] = saved[i] }) }
}
