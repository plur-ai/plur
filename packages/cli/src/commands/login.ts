import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { outputText } from '../output.js'

/**
 * plur login <host> — mint an enterprise token via OAuth device flow,
 * write it to ~/.plur/config.json, and signal the running MCP server
 * to hot-reload its configuration.
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

const HELP = `plur login — mint an enterprise token and configure the MCP server

USAGE
  plur login <host>               Authenticate against the enterprise server
  plur login <host> --no-open    Print the URL instead of opening a browser
  plur login <host> --timeout N  Poll window in seconds (default: 300)
  plur login --status            Show current auth status from ~/.plur/config.json

ARGS
  host    Enterprise server URL, e.g. https://plur.datafund.io

WHAT THIS DOES
  Uses the OAuth 2.0 Device Authorization Grant (RFC 8628) to authenticate:
    1. Fetches a device code from <host>/api/v1/auth/device
    2. Opens the verification URL in your default browser
    3. Polls for the token until you approve (or the code expires)
    4. Writes the token to ~/.plur/config.json
    5. Signals the running MCP server to hot-reload (SIGUSR1 on POSIX,
       reload-marker file on Windows)

  If no MCP server is running the token is saved and picked up on next start.
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

export function plurConfigPath(): string {
  return join(homedir(), '.plur', 'config.json')
}

export function readPlurConfig(): PlurConfig {
  const path = plurConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function writePlurConfig(config: PlurConfig): void {
  const path = plurConfigPath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

// ── Reload signal ─────────────────────────────────────────────────────────────

export function serverPidPath(): string {
  return join(homedir(), '.plur', 'server.pid')
}

export function reloadMarkerPath(): string {
  return join(homedir(), '.plur', '.reload')
}

/**
 * Send SIGUSR1 to the running MCP server (POSIX), or write a reload-marker
 * file (Windows). Returns a description of what was done.
 *
 * The MCP server records its PID in ~/.plur/server.pid on startup.
 * A missing or stale PID file is not an error — the token is already written
 * and will be picked up on next server start.
 */
export function signalReload(): string {
  const pidPath = serverPidPath()
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
    writeFileSync(reloadMarkerPath(), String(pid))
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
 */
function normaliseHost(host: string): string {
  try {
    return new URL(host).origin
  } catch {
    // If missing scheme, try prepending https://
    try {
      return new URL(`https://${host}`).origin
    } catch {
      throw new Error(`Invalid host: ${host}. Provide a full URL, e.g. https://plur.datafund.io`)
    }
  }
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
  const pollMs = Math.max(intervalSecs, 1) * 1_000

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
    if (err === 'authorization_pending' || err === 'slow_down') {
      // Still waiting for the user — keep polling
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
 */
async function openBrowser(url: string): Promise<boolean> {
  const { exec } = await import('child_process')
  const p = process.platform
  const cmd =
    p === 'darwin' ? `open "${url}"` :
    p === 'win32'  ? `start "" "${url}"` :
    `xdg-open "${url}"`
  return new Promise(resolve => {
    exec(cmd, err => resolve(!err))
  })
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
    outputText(`Error: ${parsed.error}\n\n${HELP}`)
    process.exit(1)
  }

  if (parsed.help) {
    outputText(HELP)
    return
  }

  // --status: display current auth state
  if (parsed.status) {
    const cfg = readPlurConfig()
    const ent = cfg.enterprise
    if (!ent?.url || !ent?.token) {
      outputText('Not logged in. Run `plur login <host>` to authenticate.')
      process.exit(1)
    }
    outputText(`Logged in to ${ent.url}`)
    if (ent.username) outputText(`  as ${ent.username}`)
    if (ent.authed_at) outputText(`  authenticated at ${ent.authed_at}`)
    if (ent.scopes && ent.scopes.length > 0) {
      outputText(`  scopes: ${ent.scopes.join(', ')}`)
    }
    return
  }

  if (!parsed.host) {
    outputText(`Missing required argument: <host>\n\n${HELP}`)
    process.exit(1)
  }

  let origin: string
  try {
    origin = normaliseHost(parsed.host)
  } catch (err) {
    outputText(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  const timeoutSecs = parsed.timeoutSecs ?? 300

  outputText(`Authenticating with ${origin}...`)

  // Step 1: request device code
  let deviceResp: DeviceCodeResponse
  try {
    deviceResp = await requestDeviceCode(origin)
  } catch (err) {
    outputText(`Error: ${(err as Error).message}`)
    process.exit(1)
  }

  // Step 2: present code + URL to user
  outputText('')
  outputText(`Your one-time code:  ${deviceResp.user_code}`)
  outputText(`Visit:               ${deviceResp.verification_uri}`)
  outputText('')

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
  outputText('')
  outputText(`Waiting for approval (timeout: ${timeoutSecs}s)...`)

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
        // Use process.stdout.write directly (not outputText) to stay on-line.
        process.stdout.write('.')
        dots++
        if (dots % 40 === 0) process.stdout.write('\n')
      },
    )
  } catch (err) {
    if (dots > 0) process.stdout.write('\n')
    outputText(`\nError: ${(err as Error).message}`)
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
  outputText(`\nLogged in as ${me.username} — token written to ${plurConfigPath()}`)

  // Step 6: signal hot-reload to running MCP server
  const reloadResult = signalReload()
  outputText(`Server: ${reloadResult}`)

  outputText('')
  outputText('Done. Your enterprise token is active.')
  if (me.scopes && me.scopes.length > 0) {
    outputText(`  readable scopes: ${me.scopes.join(', ')}`)
  }
}
