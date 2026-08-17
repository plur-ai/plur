/**
 * Output formatting for CLI.
 * Detects TTY vs piped, formats as human-readable or JSON.
 */

export interface OutputOptions {
  json?: boolean
  quiet?: boolean
}

/** True if stdout is a terminal (not piped). */
export function isTTY(): boolean {
  return process.stdout.isTTY === true
}

/** Determine output mode: json if --json flag or piped stdout. */
export function shouldOutputJson(options: OutputOptions): boolean {
  if (options.json !== undefined) return options.json
  return !isTTY()
}

const SECRET_KEYS = new Set([
  'token', 'api_key', 'apikey', 'password', 'secret', 'authorization',
  'refresh_token', 'access_token', 'client_secret', 'private_key',
  'bearer', 'jwt', 'auth', 'cookie', 'credential', 'credentials',
])

// URL userinfo (scheme://user:pass@host). A store URL may carry credentials in
// the password position, and config/error strings interpolate raw URLs — key-
// based redaction can't reach a secret embedded in a string value, so mask it
// here. Only the password half is masked; the username stays for diagnosis.
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi

// Secret-bearing query/fragment parameters (?token=…&api_key=…). Same class as
// URL userinfo: a credential smuggled inside a string value that key-based
// redaction can't see. Only the value is masked, and only for known secret
// param names, to avoid corrupting ordinary query strings.
const URL_SECRET_PARAM = /([?&#](?:token|api_key|apikey|access_token|auth|key|secret|password|sig|signature)=)[^&#\s]+/gi

/** Mask credentials embedded inside string values (URL userinfo + secret params). */
function maskStringSecrets(s: string): string {
  return s.replace(URL_USERINFO, '$1***$2').replace(URL_SECRET_PARAM, '$1***')
}

/**
 * Strip credential-bearing fields from anything printed as JSON.
 *
 * `StatusResult` embeds the whole `PlurConfig`, including `stores[].token` —
 * live enterprise bearer tokens. Without this, `plur status --json` pipes them
 * into CI logs, pasted issues and agent transcripts. Redaction lives at the
 * output boundary so every present and future JSON command inherits it.
 *
 * Two layers: secret-named keys (SECRET_KEYS) are replaced wholesale, and every
 * string value is scanned for credentials embedded in it (URL userinfo), since
 * a key-based denylist can't reach a password sitting inside a `stores[].url`
 * or interpolated into an error message. Value scanning is deliberately narrow
 * (URL userinfo only) to avoid corrupting legitimate output; it is not a
 * general secret scrubber.
 *
 * `path` tracks the current ancestor chain, not every object ever visited: a
 * DAG is not a cycle, and PlurConfig legitimately shares sub-objects between
 * store entries. Tracking all visited nodes would render the second reference
 * as '[Circular]' and silently drop real config from the output.
 *
 * An object that defines its own JSON form (`toJSON`, e.g. Date, Buffer)
 * serializes itself; rebuilding it via Object.entries would corrupt that form
 * (a Date would become `{}` instead of its ISO string), so it passes through.
 * Everything else is walked — plain objects AND class instances alike — so a
 * token sitting on a store driver or other non-plain object is redacted rather
 * than silently emitted, not merely assumed absent.
 */
function definesOwnJson(v: object): boolean {
  return typeof (v as { toJSON?: unknown }).toJSON === 'function'
}

export function redactSecrets(value: unknown, path = new Set<object>()): unknown {
  if (typeof value === 'string') return maskStringSecrets(value)
  if (value === null || typeof value !== 'object') return value
  const obj = value as object
  if (path.has(obj)) return '[Circular]'
  if (!Array.isArray(value) && definesOwnJson(obj)) return value

  path.add(obj)
  try {
    if (Array.isArray(value)) return value.map(v => redactSecrets(v, path))

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactSecrets(v, path)
    }
    return out
  } finally {
    path.delete(obj)
  }
}

/** Write JSON to stdout. Credentials are redacted first — see redactSecrets. */
export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(redactSecrets(data)) + '\n')
}

/** Write human-readable text to stdout. */
export function outputText(text: string): void {
  process.stdout.write(text + '\n')
}

/** Exit with code. 0 = success, 1 = error, 2 = no results. */
export function exit(code: 0 | 1 | 2, message?: string): never {
  if (message) process.stderr.write(message + '\n')
  process.exit(code)
}
