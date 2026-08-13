import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { doctorRemoteRemediation, normalizeEndpointUrl, type RemoteHealth } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputText, outputInfo, outputError, outputJson, shouldOutputJson, isQuiet } from '../output.js'

/**
 * plur login — enterprise token status (#587) and the (gated) OAuth device flow.
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
 * The device flow below is GATED (see #300/#532): enterprise servers do not
 * expose the device-flow endpoints yet, and the token it writes has no
 * consumers on the recall path — so attempting `plur login <host>` prints the
 * supported path (sign in at <host>/auth, add the store via plur_stores_add)
 * and exits 1. The implementation is kept for when B-T9 lands server-side.
 *
 * OAuth device flow:
 *   1. POST /api/v1/auth/device — request a device code
 *   2. Display the user_code + verification_url to the user
 *   3. Open verification_url in the default browser
 *   4. Poll /api/v1/auth/token every `interval` seconds until granted or expired
 *   5. Write the received token to ~/.plur/config.json
 *   6. Signal the running MCP server via SIGUSR1 (or write a reload-marker
 *      file on platforms that don't support POSIX signals)
 *
 * Usage:
 *   plur login https://plur.datafund.io
 *   plur login https://plur.datafund.io --no-open   # skip browser open
 *   plur login https://plur.datafund.io --timeout 300  # 5-min poll window
 *
 * Config written:
 *   ~/.plur/config.json  — { "enterprise": { "url": "…", "token": "…" } }
 *
 * Hot-reload signal:
 *   Reads ~/.plur/server.pid and sends SIGUSR1. The MCP server listens for
 *   SIGUSR1 and reloads its remote configuration without dropping stdio.
 *   On Windows (no SIGUSR1), writes ~/.plur/.reload to trigger a file-watch
 *   reload instead. If no running server is detected the token is still
 *   written — the server picks it up on next start.
 */

const HELP = `plur login — enterprise token status (device-flow sign-in not yet available)

USAGE
  plur login --status            Show enterprise token validity per host
  plur login --status --json     Machine-readable status report

WHAT --status DOES
  For every distinct (url, token) credential in ~/.plur/config.yaml stores:
    - decodes the JWT (display only, unverified): subject, org, expiry
    - live-probes GET <host>/api/v1/me with a short timeout
    - reports VALID / EXPIRING SOON (<7d) / EXPIRED / UNREACHABLE / INVALID
    - lists the scopes mounted locally for that host
  Token values are never printed. Exit code: 0 when all credentials are
  valid, 1 when any is EXPIRED or INVALID (or none are configured).

SIGNING IN
  \`plur login <host>\` (OAuth device flow) is not available yet — enterprise
  servers do not expose the device-flow endpoints. To connect:
    1. Sign in at <host>/auth in your browser
    2. Add the store via plur_stores_add (MCP) or \`plur stores add\`
`

// ── Types ────────────────────────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface TokenResponse {
  access_token: string
  token_type: string
  scope?: string
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

// ── Config helpers ────────────────────────────────────────────────────────────

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

export function writePlurConfig(config: PlurConfig, baseDir?: string): void {
  const path = plurConfigPath(baseDir)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
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

// ── OAuth device flow helpers ─────────────────────────────────────────────────

/**
 * Normalise the host to an origin URL (strips trailing slashes and paths).
 * Rejects http:// for non-localhost hosts — enterprise tokens must not travel over plaintext.
 */
function normaliseHost(host: string): string {
  let origin: string
  try {
    origin = new URL(host).origin
  } catch {
    // If missing scheme, try prepending https://
    try {
      origin = new URL(`https://${host}`).origin
    } catch {
      throw new Error(`Invalid host: ${host}. Provide a full URL, e.g. https://plur.datafund.io`)
    }
  }
  const parsed = new URL(origin)
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error(`Insecure host: ${host}. Use https:// (http:// is only permitted for localhost).`)
  }
  return origin
}

/**
 * POST /api/v1/auth/device — request device & user codes.
 */
export async function requestDeviceCode(origin: string): Promise<DeviceCodeResponse> {
  const url = `${origin}/api/v1/auth/device`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ client_id: 'plur-cli' }),
    })
    if (!r.ok) {
      const body = await r.text()
      throw new Error(`Device code request failed (HTTP ${r.status}): ${body}`)
    }
    const data = await r.json() as DeviceCodeResponse
    if (!data.device_code || !data.user_code || !data.verification_uri) {
      throw new Error('Unexpected response from device code endpoint')
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Poll /api/v1/auth/token until granted, expired, or timed out.
 * Returns the access token string on success.
 * Throws with a descriptive message on all failure paths.
 */
export async function pollForToken(
  origin: string,
  deviceCode: string,
  intervalSecs: number,
  timeoutSecs: number,
  onPoll?: () => void,
): Promise<TokenResponse> {
  const url = `${origin}/api/v1/auth/token`
  const deadline = Date.now() + timeoutSecs * 1_000
  let pollMs = Math.max(intervalSecs, 1) * 1_000

  while (Date.now() < deadline) {
    await sleep(pollMs)
    onPoll?.()

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    let data: TokenResponse | TokenErrorResponse
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: 'plur-cli',
        }),
      })
      data = await r.json() as TokenResponse | TokenErrorResponse
    } finally {
      clearTimeout(timer)
    }

    if ('access_token' in data && data.access_token) {
      return data as TokenResponse
    }

    const err = (data as TokenErrorResponse).error
    if (err === 'authorization_pending') {
      continue
    }
    if (err === 'slow_down') {
      // RFC 8628 §3.5 — increase interval by 5s on slow_down
      pollMs += 5_000
      continue
    }
    if (err === 'expired_token') {
      throw new Error('Device code expired. Run `plur login` again to get a new code.')
    }
    if (err === 'access_denied') {
      throw new Error('Access denied. You declined the authorisation request.')
    }
    throw new Error(`Token polling failed: ${err ?? JSON.stringify(data)}`)
  }

  throw new Error('Login timed out waiting for authorisation. Run `plur login` again.')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Attempt to fetch the authenticated user's profile after minting the token,
 * so we can display a "logged in as <username>" message and store it.
 */
async function fetchMe(origin: string, token: string): Promise<{ username: string; scopes: string[] }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5_000)
  try {
    const r = await fetch(`${origin}/api/v1/me`, {
      signal: ctrl.signal,
      headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json' },
    })
    if (!r.ok) return { username: '(unknown)', scopes: [] }
    const data = await r.json() as { username?: string; scopes?: string[] }
    return {
      username: data.username ?? '(unknown)',
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
    }
  } catch {
    return { username: '(unknown)', scopes: [] }
  } finally {
    clearTimeout(timer)
  }
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
  const p = process.platform
  // spawn with an arg array: no shell interpolation, no injection vector.
  const [cmd, cmdArgs]: [string, string[]] =
    p === 'darwin' ? ['open', [url]] :
    p === 'win32'  ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] :
    ['xdg-open', [url]]
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
    const remediation = remediationFor(status, h.url, h.tokenExpiresInDays)
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
  const plur = createPlur(flags)
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

  // Device-flow gate (#300/#532): enterprise servers do not expose the
  // device-flow endpoints yet, and the token this flow writes has no consumers
  // on the recall path — attempting it would only produce a confusing HTTP 404.
  // Point at the supported path instead. The flow below stays implemented
  // (and unit-tested) for when server-side support (B-T9) lands; flip this
  // constant to re-enable it.
  const DEVICE_FLOW_AVAILABLE = false as boolean
  if (!DEVICE_FLOW_AVAILABLE) {
    // Error-class output (#784 policy): the command cannot do what was asked
    // and exits 1, so the explanation + next steps go to stderr, unsuppressed.
    outputError('plur login (OAuth device flow) is not available yet — enterprise servers')
    outputError('do not expose the device-flow endpoints.')
    outputError('')
    outputError(`To connect to ${origin}:`)
    outputError(`  1. Sign in at ${origin}/auth in your browser`)
    outputError('  2. Add the store via plur_stores_add (MCP) or `plur stores add`')
    outputError('')
    outputError('Check existing tokens with: plur login --status')
    process.exit(1)
  }

  const timeoutSecs = parsed.timeoutSecs ?? 300

  outputInfo(`Authenticating with ${origin}...`, flags)

  // Step 1: request device code
  let deviceResp: DeviceCodeResponse
  try {
    deviceResp = await requestDeviceCode(origin)
  } catch (err) {
    outputError(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  // Step 2: present code + URL to user
  outputInfo('', flags)
  outputText(`Your one-time code:  ${deviceResp.user_code}`)
  outputText(`Visit:               ${deviceResp.verification_uri}`)
  outputInfo('', flags)

  if (parsed.noOpen) {
    outputText('Open the URL above in your browser, enter the code, and approve the request.')
  } else {
    const opened = await openBrowser(deviceResp.verification_uri)
    if (opened) {
      outputText('Opening browser... (if it does not open, visit the URL above manually)')
    } else {
      outputText('Could not open browser. Visit the URL above manually.')
    }
  }
  outputInfo('', flags)
  outputInfo(`Waiting for approval (timeout: ${timeoutSecs}s)...`, flags)

  // Step 3: poll for token
  let tokenResp: TokenResponse
  let dots = 0
  try {
    tokenResp = await pollForToken(
      origin,
      deviceResp.device_code,
      deviceResp.interval,
      timeoutSecs,
      () => {
        // Progress indicator — write dots without newlines while polling.
        // Raw stdout writes (not outputText) to stay on-line; gated on
        // --quiet like any other progress output (#730).
        if (isQuiet(flags)) return
        process.stdout.write('.')
        dots++
        if (dots % 40 === 0) process.stdout.write('\n')
      },
    )
  } catch (err) {
    if (dots > 0) process.stdout.write('\n')
    outputError(`\nError: ${(err as Error).message}`)
    process.exit(1)
  }
  if (dots > 0) process.stdout.write('\n')

  // Step 4: fetch profile (best-effort)
  const me = await fetchMe(origin, tokenResp.access_token)

  // Step 5: write token to ~/.plur/config.json
  const cfg = readPlurConfig()
  cfg.enterprise = {
    url: origin,
    token: tokenResp.access_token,
    username: me.username,
    scopes: me.scopes,
    authed_at: new Date().toISOString(),
  }
  writePlurConfig(cfg)
  outputInfo(`\nLogged in as ${me.username} — token written to ${plurConfigPath()}`, flags)

  // Step 6: signal hot-reload to running MCP server
  const reloadResult = signalReload()
  outputInfo(`Server: ${reloadResult}`, flags)

  outputInfo('', flags)
  outputInfo('Done. Your enterprise token is active.', flags)
  if (me.scopes && me.scopes.length > 0) {
    outputInfo(`  readable scopes: ${me.scopes.join(', ')}`, flags)
  }
}
