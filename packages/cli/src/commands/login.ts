import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, hostname, release } from 'os'
import {
  doctorRemoteRemediation, normalizeEndpointUrl, redactToken, detectPlurStorage, PersonalScopeTakenError,
  resolveScopeTarget, loadConfig,
  type RemoteHealth,
} from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputText, outputInfo, outputError, outputJson, shouldOutputJson } from '../output.js'
import { urlOpener } from '../lib/open-url.js'
import { deviceName, isHeadless, isWslRelease } from '../enterprise/device-name.js'
import { migrateLegacyLogin } from '../enterprise/legacy-login.js'
import {
  normaliseHost, readJson, fetchMe, personalScopeOf, holderLine, takeoverMessage, backupSecretFile, redactConsoleWith,
  type FetchFn, type MeAnswer,
} from '../enterprise/sign-in-shared.js'

// Shared with enterprise/legacy-login.ts through sign-in-shared.ts (no import
// cycle); re-exported here, where callers and tests have always found them.
export { normaliseHost, fetchMe, personalScopeOf, takeoverMessage, type MeAnswer }

/**
 * plur login — enterprise token status (#587) and device sign-in (#1638).
 *
 * `plur login --status` reports each configured enterprise credential's
 * validity instead of dumping raw config: one row per DISTINCT (url, token)
 * group in `~/.plur/config.yaml` stores (core's `remoteEndpointTokenGroups`,
 * the #776 grouping), each with the JWT's display-only subject/org + expiry,
 * a live `/api/v1/me` probe (via core's `checkRemoteHealth` — the same probe
 * `plur_doctor` uses), and the locally mounted scopes. Token values are never
 * printed. Exit 0 when every credential is valid; 1 when any is EXPIRED or
 * INVALID (script-friendly).
 *
 * `plur login <host>` signs this device in with the OAuth device flow
 * (RFC 8628, contract C3), shared with `plur-enterprise init`:
 *   1. POST /api/v1/auth/device { client_id: 'plur-cli', device_name }
 *   2. Print the sign-in page and the code; open the page in a browser unless
 *      this is a headless session (SSH, no display) or --no-open
 *   3. Poll POST /api/v1/auth/token at the server's interval (slow_down adds
 *      5 s for the rest of the run; a 429 waits Retry-After) until the key, a
 *      refusal, or the code's expiry
 *   4. GET /api/v1/me with the key: the personal scope user:<org>:<username>
 *   5. Write the one server entry to ~/.plur/config.yaml through core's
 *      registration (`Plur.registerEnterpriseServer`, the config write path),
 *      then fetch its scopes (`Plur.refreshServerScopes`)
 * The key is never printed or logged and is written only in step 5, only
 * after an `ok` token answer. Nothing is written before then, so ctrl-C
 * leaves config.yaml as it was. `~/.plur/config.json` is no longer written;
 * a remaining one is moved into config.yaml once (enterprise/legacy-login.ts).
 *
 * Usage:
 *   plur login https://plur.example.com
 *   plur login https://plur.example.com --no-open        # do not open a browser
 *   plur login https://plur.example.com --timeout 300    # stop waiting after 5 min
 *   plur login https://plur.example.com --remove-stale   # remove an entry holding your personal scope
 */

const HELP = `plur login — sign this device in to a PLUR server, or check the tokens you have

USAGE
  plur login <host>              Sign in with the device flow and save the server
  plur login <host> --no-open    Print the sign-in page and code; do not open a browser
  plur login <host> --timeout N  Stop waiting for approval after N seconds
  plur login <host> --remove-stale
                                 Also remove an entry in config.yaml that holds your
                                 personal scope (config.yaml is backed up first)
  plur login --status            Show enterprise token validity per host
  plur login --status --json     Machine-readable status report

SIGNING IN
  Prints a sign-in page on <host> and a code. Open the page (on any device),
  sign in, and enter the code. The device key the server sends is saved as the
  server's entry in ~/.plur/config.yaml (never printed), with your personal
  scope from the server's /me answer. Nothing is written until the key
  arrives, so ctrl-C changes nothing.

WHAT --status DOES
  For every distinct (url, token) credential in ~/.plur/config.yaml stores:
    - decodes the JWT (display only, unverified): subject, org, expiry
    - live-probes GET <host>/api/v1/me with a short timeout
    - reports VALID / EXPIRING SOON (<7d) / EXPIRED / UNREACHABLE / INVALID
    - lists the scopes mounted locally for that host
  Token values are never printed. Exit code: 0 when all credentials are
  valid, 1 when any is EXPIRED or INVALID (or none are configured).

~/.plur/config.json
  Older versions of \`plur login\` wrote ~/.plur/config.json. It is no longer
  written. A remaining one is moved into config.yaml once (when the server
  still accepts it), with a notice, and set aside under ~/.plur/backups/.
`

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

/** The C3 `200` answer of `/api/v1/auth/token`, delivered once. */
export interface TokenResponse {
  access_token: string
  token_type: string
  username: string
  key_id: string
  key_name: string
}

interface TokenErrorResponse {
  error: string
  error_description?: string
}

interface PlurConfig {
  enterprise?: {
    url: string
    token: string
    username?: string
    scopes?: string[]
    authed_at?: string
  }
  [key: string]: unknown
}

// ── Legacy config.json (read only) ───────────────────────────────────────────

/** `~/.plur/config.json`, written by `plur login` before #1638; read only now. */
export function plurConfigPath(baseDir?: string): string {
  return join(baseDir ?? homedir(), '.plur', 'config.json')
}

export function readPlurConfig(baseDir?: string): PlurConfig {
  const path = plurConfigPath(baseDir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

// ── Reload signal ─────────────────────────────────────────────────────────────

export function serverPidPath(baseDir?: string): string {
  return join(baseDir ?? homedir(), '.plur', 'server.pid')
}

export function reloadMarkerPath(baseDir?: string): string {
  return join(baseDir ?? homedir(), '.plur', '.reload')
}

/**
 * Send SIGUSR1 to the running MCP server (POSIX), or write a reload-marker
 * file (Windows). Returns a description of what was done.
 *
 * The MCP server records its PID in ~/.plur/server.pid on startup.
 * A missing or stale PID file is not an error — the token is already written
 * and will be picked up on next server start.
 */
export function signalReload(baseDir?: string): string {
  const pidPath = serverPidPath(baseDir)
  if (!existsSync(pidPath)) {
    return 'no running server detected (no PID file) — token saved, will be picked up on next start'
  }

  const pidStr = readFileSync(pidPath, 'utf8').trim()
  const pid = parseInt(pidStr, 10)
  if (!pid || Number.isNaN(pid)) {
    return 'invalid PID file — token saved, restart the MCP server to apply'
  }

  // Windows: no SIGUSR1 — write a reload-marker instead.
  if (process.platform === 'win32') {
    writeFileSync(reloadMarkerPath(baseDir), String(pid))
    return `reload marker written (PID ${pid}) — the server will reload on next tool call`
  }

  // POSIX: send SIGUSR1. If the process is gone the error code is ESRCH.
  try {
    process.kill(pid, 'SIGUSR1')
    return `hot-reload signal sent to server PID ${pid}`
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      return `server PID ${pid} is no longer running — token saved, start the MCP server to apply`
    }
    return `could not signal server PID ${pid} (${err.message}) — token saved`
  }
}

// ── OAuth device flow (RFC 8628, contract C3) ────────────────────────────────

/** The client id the server knows this CLI by (C3). */
export const DEVICE_CLIENT_ID = 'plur-cli'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** C3 user codes: two groups of four consonants (no vowels, no digits). */
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/
/** A PLUR device key: `plur_sk_` and at least 16 base64url characters. */
const KEY_RE = /^plur_sk_[A-Za-z0-9_-]{16,}$/
const UNEXPECTED = 'unexpected answer from the server'
/** RFC 8628 §3.5: each slow_down (and a 429 without Retry-After) adds 5 s. */
const SLOW_DOWN_MS = 5_000
/** Longest Retry-After honoured; a longer one is capped so a run cannot hang. */
const RETRY_AFTER_MAX_S = 120
/** Network errors and 5xx answers in a row before the poll gives up. */
const TRANSIENT_MAX = 3
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RERUN_HINT = 'Run `plur login` again.'

type SleepFn = (ms: number) => Promise<void>

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function lcFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s
}

/** Retry-After in whole seconds (the form the server sends), capped; else undefined. */
function retryAfterSeconds(r: Response): number | undefined {
  const v = r.headers.get('retry-after')
  if (!v || !/^\d{1,6}$/.test(v.trim())) return undefined
  return Math.min(Number(v.trim()), RETRY_AFTER_MAX_S)
}

/**
 * POST a JSON body and read the JSON answer, both under one timeout: the
 * abort stays armed until the body is read, so a server that sends headers
 * and then trickles the body cannot hold the run (a body cut off by the
 * timeout reads as no JSON).
 */
async function postJson(f: FetchFn, url: string, body: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<{ r: Response; data: Record<string, unknown> | undefined }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await f(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body),
    })
    return { r, data: await readJson(r) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * POST /api/v1/auth/device — request device & user codes (C3). A `429` is
 * retried once, after Retry-After (else 5 s); a second one is refused with a
 * plain message.
 */
export async function requestDeviceCode(
  origin: string,
  opts: { deviceName?: string; fetch?: FetchFn; sleep?: SleepFn; rerunHint?: string; requestTimeoutMs?: number } = {},
): Promise<DeviceCodeResponse> {
  const f = opts.fetch ?? fetch
  const pause = opts.sleep ?? sleep
  const url = `${origin}/api/v1/auth/device`
  const body = { client_id: DEVICE_CLIENT_ID, ...(opts.deviceName ? { device_name: opts.deviceName } : {}) }
  for (let attempt = 0; ; attempt++) {
    let r: Response
    let data: Record<string, unknown> | undefined
    try {
      ({ r, data } = await postJson(f, url, body, opts.requestTimeoutMs))
    } catch (err) {
      throw new Error(`Could not reach ${origin} (${(err as Error)?.name === 'AbortError' ? 'timed out' : 'network error'}).`)
    }
    if (r.status === 429) {
      if (attempt === 0) {
        await pause((retryAfterSeconds(r) ?? 5) * 1000)
        continue
      }
      throw new Error(`The PLUR server is busy with sign-ins from your network. Wait a minute, then ${lcFirst(opts.rerunHint ?? DEFAULT_RERUN_HINT)}`)
    }
    if (!r.ok) {
      throw new Error(`Device code request failed (HTTP ${r.status}).`)
    }
    if (!data || typeof data.device_code !== 'string' || !data.device_code ||
      typeof data.user_code !== 'string' || typeof data.verification_uri !== 'string') {
      throw new Error('Unexpected response from the device code endpoint.')
    }
    return data as unknown as DeviceCodeResponse
  }
}

/**
 * Poll /api/v1/auth/token until the key arrives, the server refuses, or
 * `timeoutSecs` pass (callers pass the code's `expires_in`). Waits `interval`
 * before each poll; `slow_down` adds 5 s for the rest of the run, a `429`
 * waits its Retry-After once (else counts as slow_down), and up to three
 * network errors or 5xx answers in a row are waited out. Returns the `200`
 * answer as sent; {@link deviceSignIn} checks it. No error message carries
 * the key or a server-supplied text.
 */
export async function pollForToken(
  origin: string,
  deviceCode: string,
  intervalSecs: number,
  timeoutSecs: number,
  onPoll?: () => void,
  opts: { fetch?: FetchFn; sleep?: SleepFn; rerunHint?: string } = {},
): Promise<TokenResponse> {
  const f = opts.fetch ?? fetch
  const pause = opts.sleep ?? sleep
  const rerun = opts.rerunHint ?? DEFAULT_RERUN_HINT
  const url = `${origin}/api/v1/auth/token`
  const limitMs = Math.max(0, timeoutSecs) * 1000
  const started = Date.now()
  let waited = 0
  let intervalMs = (Number.isFinite(intervalSecs) && intervalSecs >= 1 ? intervalSecs : 1) * 1000
  let nextWaitMs: number | undefined
  let transient = 0

  const expired = (): Error => new Error(`Sign-in timed out: the code expired before it was entered. ${rerun}`)
  // Time used: the waits (as asked of `sleep`), or the wall clock if that is
  // more. One deadline: no wait and no request runs past it (a request's
  // timeout is the time left), and no answer that arrives after it counts.
  const remaining = (): number => limitMs - Math.max(Date.now() - started, waited)
  const late = (sent: number): boolean => remaining() <= 0 || waited + (Date.now() - sent) >= limitMs
  for (;;) {
    if (remaining() <= 0) throw expired()
    const ms = Math.min(nextWaitMs ?? intervalMs, remaining())
    nextWaitMs = undefined
    await pause(ms)
    waited += ms
    if (remaining() <= 0) throw expired()
    onPoll?.()

    let r: Response
    let data: Record<string, unknown> | undefined
    const sent = Date.now()
    try {
      ({ r, data } = await postJson(f, url, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: DEVICE_CLIENT_ID },
        Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining()))))
    } catch {
      if (late(sent)) throw expired()
      if (++transient > TRANSIENT_MAX) throw new Error(`Could not reach ${origin} while waiting for the sign-in. ${rerun}`)
      continue
    }
    if (late(sent)) throw expired()
    if (r.status === 429) {
      // Never sooner than the interval: a Retry-After of 0 must not turn the
      // poll into a tight loop against the server.
      const ra = retryAfterSeconds(r)
      if (ra !== undefined) nextWaitMs = Math.max(ra * 1000, intervalMs)
      else intervalMs += SLOW_DOWN_MS
      continue
    }
    if (r.status >= 500) {
      if (++transient > TRANSIENT_MAX) throw new Error(`The server could not complete the sign-in (HTTP ${r.status}). ${rerun}`)
      continue
    }
    transient = 0
    if (r.ok && data && typeof data.access_token === 'string' && data.access_token) {
      return data as unknown as TokenResponse
    }
    const err = (data as TokenErrorResponse | undefined)?.error
    if (err === 'authorization_pending') continue
    if (err === 'slow_down') { intervalMs += SLOW_DOWN_MS; continue }
    if (err === 'access_denied') throw new Error('Sign-in was cancelled in the browser. Nothing was changed.')
    if (err === 'expired_token') throw new Error(`The code expired before it was entered. ${rerun}`)
    if (err === 'invalid_grant') throw new Error(`The server no longer knows this sign-in request (already used or unknown). ${rerun}`)
    // Only a code this client knows is named; any other text is the server's
    // and could carry anything, a key included.
    const known = ['invalid_request', 'invalid_client', 'unsupported_grant_type', 'unauthorized_client', 'server_error']
    const named = typeof err === 'string' && known.includes(err) ? `: ${err}` : ''
    throw new Error(`Sign-in failed, ${UNEXPECTED}${named} (HTTP ${r.status}). ${rerun}`)
  }
}

export interface DeviceSignInOptions {
  /** The server's origin (see {@link normaliseHost}). */
  server: string
  deviceName: string
  fetch: FetchFn
  sleep: SleepFn
  print: (line: string) => void
  openBrowser: (url: string) => Promise<boolean>
  headless: boolean
  rerunHint: string
  /** Stop waiting after this many seconds, if sooner than the code's expiry. */
  timeoutSecs?: number
}

export interface DeviceSignInResult {
  key: string
  keyId: string
  keyName: string
  username: string
}

/**
 * The device sign-in, shared by `plur login <host>` and `plur-enterprise
 * init`: request a code, print the page and code (a page off the server's own
 * origin, or a code outside the C3 alphabet, is refused before anything is
 * printed), open the page unless headless, poll for the key, and check the
 * `200` answer (token_type Bearer, a PLUR device key, the C3 fields). Writes
 * nothing; the key is returned, never printed.
 */
export async function deviceSignIn(opts: DeviceSignInOptions): Promise<DeviceSignInResult> {
  const origin = normaliseHost(opts.server)
  const dev = await requestDeviceCode(origin, { deviceName: opts.deviceName, fetch: opts.fetch, sleep: opts.sleep, rerunHint: opts.rerunHint })
  const issued = Date.now()   // the code's lifetime runs from here, browser time included

  if (!USER_CODE_RE.test(dev.user_code)) throw new Error(UNEXPECTED)
  let page: URL
  try { page = new URL(dev.verification_uri) } catch { throw new Error(UNEXPECTED) }
  if (page.origin !== origin || page.username || page.password) {
    throw new Error(`${UNEXPECTED}: the sign-in page is not on ${origin}`)
  }
  const expiresIn = Number.isFinite(dev.expires_in) && dev.expires_in > 0 ? dev.expires_in : 600
  const interval = Number.isFinite(dev.interval) && dev.interval > 0 ? dev.interval : 5
  const timeout = opts.timeoutSecs !== undefined ? Math.min(opts.timeoutSecs, expiresIn) : expiresIn

  opts.print(`Go to  ${page.href}  and enter the code  ${dev.user_code}`)
  if (!opts.headless) {
    const opened = await opts.openBrowser(page.href).catch(() => false)
    if (opened) opts.print('A browser window was opened. If it did not open, use the page above.')
  }
  opts.print('Waiting for you to approve the sign-in…')

  const tok = await pollForToken(origin, dev.device_code, interval, timeout - (Date.now() - issued) / 1000, undefined,
    { fetch: opts.fetch, sleep: opts.sleep, rerunHint: opts.rerunHint })

  // These are printed (the user name and key name): no control characters,
  // so a server answer cannot drive the terminal.
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v)
  if (typeof tok.token_type !== 'string' || tok.token_type.toLowerCase() !== 'bearer' ||
    !KEY_RE.test(tok.access_token) || !str(tok.username) || !str(tok.key_id) || !str(tok.key_name)) {
    throw new Error(UNEXPECTED)
  }
  return { key: tok.access_token, keyId: tok.key_id, keyName: tok.key_name, username: tok.username }
}

/**
 * Open a URL in the system default browser, best-effort.
 * Returns true if the open command was dispatched, false if unsupported.
 * Uses spawn with an argument array (no shell) to prevent command injection
 * via a server-controlled verification_uri.
 */
async function openBrowser(url: string): Promise<boolean> {
  // Validate scheme — only open http(s) URLs.
  let scheme: string
  try { scheme = new URL(url).protocol } catch { return false }
  if (scheme !== 'http:' && scheme !== 'https:') return false

  const { spawn } = await import('child_process')
  // spawn with an arg array: no shell interpolation, no injection vector.
  const [cmd, cmdArgs] = urlOpener(url)
  return new Promise(resolve => {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' })
    child.unref()
    child.on('error', () => resolve(false))
    child.on('spawn', () => resolve(true))
  })
}

// ── Token status (#587) ───────────────────────────────────────────────────────

/** Live `/me` probe budget for --status — short: a status readout must not hang. */
export const STATUS_PROBE_TIMEOUT_MS = 3000

/** Days-to-expiry below which a valid token is flagged EXPIRING SOON. */
export const EXPIRING_SOON_DAYS = 7

export type TokenStatusLabel = 'VALID' | 'EXPIRING SOON' | 'EXPIRED' | 'UNREACHABLE' | 'INVALID'

export interface HostTokenStatus {
  url: string
  status: TokenStatusLabel
  /** JWT `sub` (unverified) or, when the probe succeeded, the server's username. */
  subject?: string
  /** JWT org claim (unverified) or the server's org_id. */
  org?: string
  tokenExpiresAt?: string
  tokenExpiresInDays?: number | null
  /** Human-readable relative expiry: "expires in 23d" / "EXPIRED 3d ago". */
  expiry: string
  probe: {
    /** False when the probe was skipped (token already expired locally). */
    probed: boolean
    reachable?: boolean
    /** Scopes the server reports granted to this token (probe ok only). */
    grantedScopes?: number
    reason?: string
  }
  /** Scopes mounted locally (config.yaml stores) for this (url, token) group. */
  mountedScopes: string[]
  remediation?: string
}

export interface LoginStatusReport {
  hosts: HostTokenStatus[]
  /** A `plur login`-written ~/.plur/config.json token not mounted as a store —
   *  it has no consumers on the recall path, so flag it instead of probing it. */
  legacyLogin?: { url: string; mounted: boolean }
  /** True when at least one credential is configured and none is EXPIRED/INVALID. */
  ok: boolean
}

/**
 * Classify one probed credential. EXPIRED means the JWT itself is past its
 * `exp` (locally decodable — the strongest signal); INVALID means the server
 * rejected a token that is not visibly expired (revoked, wrong, or opaque);
 * UNREACHABLE is a network-class failure and deliberately NOT an auth verdict.
 */
export function classifyTokenStatus(h: Pick<RemoteHealth, 'status' | 'tokenExpiresInDays'>): TokenStatusLabel {
  if (h.status === 'ok') {
    const d = h.tokenExpiresInDays
    return typeof d === 'number' && d >= 0 && d < EXPIRING_SOON_DAYS ? 'EXPIRING SOON' : 'VALID'
  }
  if (h.status === 'auth_expired') {
    return typeof h.tokenExpiresInDays === 'number' && h.tokenExpiresInDays < 0 ? 'EXPIRED' : 'INVALID'
  }
  return 'UNREACHABLE'
}

/** "expires in 23d" / "EXPIRED 3d ago" / opaque-key fallback. */
export function formatRelativeExpiry(days: number | null | undefined): string {
  if (typeof days !== 'number') return 'no expiry claim (not a JWT)'
  if (days < 0) return `EXPIRED ${-days}d ago`
  if (days === 0) return 'expires in <1d'
  return `expires in ${days}d`
}

/**
 * Remediation per label — REUSES the A4′ doctor strings (remote-recall.ts) so
 * every surface gives the same instruction: sign in at <host>/auth and re-add
 * via plur_stores_add. Never suggests running `plur login` — enterprise
 * servers have no device-flow endpoints (the A4′ strings say so explicitly).
 */
function remediationFor(label: TokenStatusLabel, url: string, expiresInDays?: number | null): string | undefined {
  const host = normalizeEndpointUrl(url)
  switch (label) {
    case 'EXPIRED':
    case 'INVALID':
      return doctorRemoteRemediation({ host, status: 'auth_expired' }) ?? undefined
    case 'UNREACHABLE':
      return doctorRemoteRemediation({ host, status: 'unreachable' }) ?? undefined
    case 'EXPIRING SOON':
      return `Token for ${host} expires in ${expiresInDays}d — sign in at ${host}/auth and re-add the store via plur_stores_add before it expires.`
    case 'VALID':
      return undefined
  }
}

/** Build the full --status report from checkRemoteHealth results. Pure. */
export function buildStatusReport(
  health: RemoteHealth[],
  legacyLogin?: { url: string; mounted: boolean },
): LoginStatusReport {
  const hosts: HostTokenStatus[] = health.map(h => {
    const status = classifyTokenStatus(h)
    const locallyExpired = typeof h.tokenExpiresInDays === 'number' && h.tokenExpiresInDays < 0
    const probe: HostTokenStatus['probe'] =
      h.status === 'ok'
        ? { probed: true, reachable: true, ...(h.grantedScopes !== undefined ? { grantedScopes: h.grantedScopes } : {}) }
        : h.status === 'auth_expired' && locallyExpired
          ? { probed: false, reason: 'skipped — token already expired' }
          : h.status === 'auth_expired'
            ? { probed: true, reachable: true, ...(h.reason ? { reason: h.reason } : {}) }
            : { probed: true, reachable: false, ...(h.reason ? { reason: h.reason } : {}) }
    // #1564 review M2: an unset token_env variable is fixed by setting it, not by re-authenticating.
    const remediation = h.tokenEnvUnset
      ? `Set the environment variable ${h.tokenEnvUnset} where PLUR runs — it holds the token for ${normalizeEndpointUrl(h.url)}.`
      : remediationFor(status, h.url, h.tokenExpiresInDays)
    return {
      url: h.url,
      status,
      ...(h.tokenSubject ?? h.username ? { subject: h.tokenSubject ?? h.username } : {}),
      ...(h.tokenOrg ?? h.orgId ? { org: h.tokenOrg ?? h.orgId } : {}),
      ...(h.tokenExpiresAt ? { tokenExpiresAt: h.tokenExpiresAt } : {}),
      tokenExpiresInDays: h.tokenExpiresInDays ?? null,
      expiry: formatRelativeExpiry(h.tokenExpiresInDays),
      probe,
      mountedScopes: h.scopes,
      ...(remediation ? { remediation } : {}),
    }
  })
  return {
    hosts,
    ...(legacyLogin ? { legacyLogin } : {}),
    ok: hosts.length > 0 && hosts.every(h => h.status !== 'EXPIRED' && h.status !== 'INVALID'),
  }
}

const STATUS_MARK: Record<TokenStatusLabel, string> = {
  'VALID': '✓',
  'EXPIRING SOON': '!',
  'UNREACHABLE': '?',
  'EXPIRED': '✗',
  'INVALID': '✗',
}

/** Human-readable --status lines. Pure (testable); never includes token values. */
export function formatStatusLines(report: LoginStatusReport): string[] {
  const lines: string[] = []
  if (report.hosts.length === 0) {
    lines.push('No enterprise tokens configured (no remote stores in ~/.plur/config.yaml).')
    lines.push('To connect: sign in at your enterprise server\'s /auth page and add the store via plur_stores_add.')
  } else {
    lines.push(`Enterprise token status — ${report.hosts.length} credential(s)`)
    for (const h of report.hosts) {
      lines.push('')
      lines.push(`${STATUS_MARK[h.status]} ${h.url} — ${h.status}`)
      if (h.subject || h.org) {
        lines.push(`    identity: ${h.subject ?? '(unknown)'}${h.org ? ` (org: ${h.org})` : ''}`)
      }
      lines.push(`    token:    ${h.expiry}${h.tokenExpiresAt ? ` (${h.tokenExpiresAt.slice(0, 10)})` : ''}`)
      if (!h.probe.probed) {
        lines.push(`    server:   not probed — token already expired`)
      } else if (h.probe.reachable && (h.status === 'VALID' || h.status === 'EXPIRING SOON')) {
        lines.push(`    server:   reachable — ${h.probe.grantedScopes ?? 0} scope(s) granted`)
      } else if (h.probe.reachable) {
        lines.push(`    server:   reachable — token rejected${h.probe.reason ? ` (${h.probe.reason})` : ''}`)
      } else {
        lines.push(`    server:   unreachable${h.probe.reason ? ` (${h.probe.reason})` : ''}`)
      }
      lines.push(`    mounted:  ${h.mountedScopes.length > 0 ? h.mountedScopes.join(', ') : '(none)'}`)
      if (h.remediation) lines.push(`    fix:      ${h.remediation}`)
    }
  }
  if (report.legacyLogin && !report.legacyLogin.mounted) {
    lines.push('')
    lines.push(`Note: ~/.plur/config.json holds a legacy \`plur login\` token for ${report.legacyLogin.url} that is`)
    lines.push('not mounted as a store — nothing reads it. Sign in at the server\'s /auth page and add the')
    lines.push('store via plur_stores_add instead.')
  }
  return lines
}

/** `plur login --status` — build, print, and exit (0 all valid / 1 otherwise). */
async function runStatus(flags: GlobalFlags): Promise<never> {
  // A status readout writes nothing: no project-store discovery (#1665 gate).
  const plur = createPlur(flags, { autoDiscover: false })
  let health: RemoteHealth[] = []
  try {
    health = await plur.checkRemoteHealth({ timeoutMs: STATUS_PROBE_TIMEOUT_MS })
  } catch { /* belt-and-braces: checkRemoteHealth captures per-endpoint failures itself */ }

  // Legacy `plur login`-written token (config.json): note-only — it is not on
  // the recall path, so it is flagged rather than probed.
  let legacyLogin: { url: string; mounted: boolean } | undefined
  const ent = readPlurConfig().enterprise
  if (ent?.url && ent?.token) {
    let mounted = false
    try {
      const key = normalizeEndpointUrl(ent.url)
      mounted = plur.remoteEndpointTokenGroups()
        .some(g => normalizeEndpointUrl(g.url) === key && (g.token ?? '') === ent.token)
    } catch { /* unparseable legacy URL → report as unmounted */ }
    legacyLogin = { url: ent.url, mounted }
  }

  const report = buildStatusReport(health, legacyLogin)
  if (shouldOutputJson(flags)) {
    outputJson(report)
  } else {
    // Primary output of --status — never suppressed by --quiet (#784 policy).
    for (const line of formatStatusLines(report)) outputText(line)
  }
  process.exit(report.ok ? 0 : 1)
}

// ── Args parser ───────────────────────────────────────────────────────────────

interface ParsedArgs {
  host?: string
  noOpen?: boolean
  timeoutSecs?: number
  status?: boolean
  removeStale?: boolean
  help?: boolean
  error?: string
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--no-open')            { out.noOpen = true; continue }
    if (a === '--status')             { out.status = true; continue }
    if (a === '--remove-stale')       { out.removeStale = true; continue }
    if (a === '--timeout') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        return { error: '--timeout requires a value (number of seconds)' }
      }
      const n = parseInt(next, 10)
      if (Number.isNaN(n) || n <= 0) {
        return { error: `--timeout must be a positive integer, got: ${next}` }
      }
      out.timeoutSecs = n
      i++
      continue
    }
    if (!a.startsWith('--')) {
      if (out.host) return { error: `unexpected positional argument: ${a}` }
      out.host = a
      continue
    }
    return { error: `unknown flag: ${a}` }
  }
  return out
}

// ── Sign-in: write the server entry ──────────────────────────────────────────

async function runSignIn(origin: string, parsed: ParsedArgs, flags: GlobalFlags): Promise<never> {
  // Nothing is written until the key has arrived, been checked and its /me
  // answered; registration is then one locked, atomic write. A ctrl-C before
  // it leaves config.yaml as it was; after it, the entry is complete.
  let saved = false
  process.once('SIGINT', () => {
    outputError(saved
      ? `\nCancelled. ${origin} was already saved to config.yaml.`
      : '\nSign-in cancelled. Nothing was changed.')
    process.exit(130)
  })

  const rerunHint = 'Run `plur login` again.'
  let signedIn: DeviceSignInResult
  try {
    signedIn = await deviceSignIn({
      server: origin,
      deviceName: deviceName(hostname(), process.platform, isWslRelease(release(), process.env)),
      fetch,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      print: outputText,
      openBrowser,
      headless: parsed.noOpen === true || isHeadless(process.env, process.platform),
      rerunHint,
      timeoutSecs: parsed.timeoutSecs,
    })
  } catch (err) {
    outputError(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
  const key = signedIn.key
  // Core logs some server text itself (during registration and the scope
  // refresh); the key is redacted from every line this process prints.
  redactConsoleWith(key)
  const fail = (lines: string[]): never => {
    for (const l of lines) outputError(redactToken(l, key))
    process.exit(1)
  }

  const me = await fetchMe(origin, key)
  if (me.status !== 'ok') {
    fail([
      `Signed in as ${signedIn.username}, but ${origin}/api/v1/me ${me.status === 'rejected' ? `refused the new key (HTTP ${me.httpStatus})` : `did not answer (${me.reason})`},`,
      'so your personal scope is not known. Nothing was changed, and the key from this sign-in was not saved.',
      rerunHint,
    ])
  }
  const personalScope = personalScopeOf(me as Extract<MeAnswer, { status: 'ok' }>)

  const root = flags.path || process.env.PLUR_PATH || undefined
  const configPath = detectPlurStorage(root).config
  const plur = createPlur(flags, { autoDiscover: false })
  // Every line from here on is redacted with the key: the server's user
  // name, key name, scopes and errors are its own text and could repeat it.
  const say = (line: string): void => outputText(redactToken(line, key))
  let backup: string | undefined
  let result: Awaited<ReturnType<typeof plur.registerEnterpriseServer>>
  try {
    // The backup is taken under registration's config lock, from the file it
    // is about to rewrite, and only when stale entries are removed; a backup
    // that cannot be made owner-only refuses the whole write.
    result = await plur.registerEnterpriseServer(origin, {
      token: key, personalScope, removeStale: parsed.removeStale === true,
      beforeRemove: p => { backup = backupSecretFile(dirname(p), p) },
    })
    saved = true
  } catch (err) {
    if (err instanceof PersonalScopeTakenError) fail(takeoverMessage(err, origin, configPath))
    fail([
      `Signed in, but ${origin} could not be saved: ${(err as Error).message}`,
      'The key from this sign-in was not saved.',
    ])
  }

  say(`Signed in to ${origin} as ${signedIn.username}. Saved as the server's entry in ${configPath} (key "${signedIn.keyName}").`)
  if (result!.removed.length) {
    say(`Removed ${result!.removed.length === 1 ? 'the entry' : 'the entries'} that held ${personalScope}:`)
    for (const h of result!.removed) say(holderLine(h))
    if (backup) say(`The previous config.yaml was saved to ${backup}`)
  }
  // Registration refuses only a takeover. An entry that keeps serving the
  // personal scope ahead of the new one (an older entry for this server with
  // another key, say) still gets the personal writes: say so, and exit 1.
  let elsewhere: string | undefined
  try {
    const t = resolveScopeTarget(personalScope, loadConfig(configPath).stores ?? [])
    if (t.kind === 'remote' && !(typeof t.entry.url === 'string' && normalizeEndpointUrl(t.entry.url) === normalizeEndpointUrl(origin) && t.entry.token === key)) {
      let where = 'a server'
      try { if (typeof t.entry.url === 'string') where = new URL(t.entry.url).origin } catch { /* unnamed */ }
      elsewhere = `another entry for ${where}${t.entry.token !== key ? ' with another key' : ''}`
    } else if (t.kind === 'local') {
      elsewhere = 'a local store (a path entry)'
    } else if (t.kind === 'conflict') {
      elsewhere = `no server: ${t.servers.length} servers claim it, so personal writes are refused`
    }
  } catch { /* the route could not be read; the entry is saved */ }
  if (elsewhere) {
    for (const l of [
      `Your personal scope ${personalScope} is still served by ${elsewhere} in ${configPath},`,
      `so your personal writes do not use this sign-in. Remove that entry (or its ${personalScope} scope) from ${configPath}.`,
    ]) outputError(redactToken(l, key))
  }
  let discovery: Awaited<ReturnType<typeof plur.refreshServerScopes>> = []
  try { discovery = await plur.refreshServerScopes({ url: origin }) } catch { /* reported below */ }
  const d = discovery[0]
  if (d?.status === 'ok' || d?.status === 'degraded') {
    say(`Scopes: ${d.scopes.length ? d.scopes.join(', ') : '(none yet)'}`)
  } else if (d?.status === 'not_synced') {
    say('Your account is not in the server\'s graph yet; its scopes will be fetched at a later session start.')
  } else {
    say(`Scopes could not be fetched now${d?.error ? ` (${d.error})` : ''}; they are fetched at the next session start.`)
  }
  outputInfo(redactToken(`Server: ${signalReload()}`, key), flags)
  process.exit(elsewhere ? 1 : 0)
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.error) {
    outputError(`Error: ${parsed.error}\n\n${HELP}`)
    process.exit(1)
  }

  if (parsed.help) {
    outputText(HELP)
    return
  }

  // O15: a remaining ~/.plur/config.json is moved into config.yaml once.
  await migrateLegacyLogin({ home: homedir(), plur: () => createPlur(flags, { autoDiscover: false }), print: outputError })

  // --status: token validity per configured (url, token) credential (#587)
  if (parsed.status) {
    await runStatus(flags)
  }

  if (!parsed.host) {
    outputError(`Missing required argument: <host>\n\n${HELP}`)
    process.exit(1)
  }

  let origin: string
  try {
    origin = normaliseHost(parsed.host)
  } catch (err) {
    outputError(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  outputInfo(`Signing in to ${origin}…`, flags)
  await runSignIn(origin, parsed, flags)
}
