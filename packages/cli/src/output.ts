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

function definesOwnJson(v: object): boolean {
  return typeof (v as { toJSON?: unknown }).toJSON === 'function'
}

/**
 * Strip credential-bearing fields from anything printed as JSON (e.g.
 * `stores[].token` in `StatusResult`), at the output boundary so every JSON command
 * inherits it.
 * - Secret-named keys (SECRET_KEYS) are replaced; string values are narrowly scanned
 *   for embedded credentials (URL userinfo, known secret query params).
 * - `path` tracks only the ancestor chain: shared sub-objects (a DAG) are not cycles.
 * - Objects with `toJSON` (Date, Buffer) pass through; all others, incl. class
 *   instances, are walked so a token on a store driver is redacted.
 */
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

// ── --quiet policy ─────────────────────────────────────────────────────────
// SUPPRESSED: progress lines, confirmations of a requested mutation, banners,
//   hints, summary footers.
// PRESERVED: the primary output, warnings that the outcome DIFFERS from the request,
//   errors (stderr), exit codes, all `--json` output, hook-* protocol stdout.
// The entry point calls {@link setQuiet} once; call sites may still pass `flags`,
// which override it. Ambiguous lines use {@link outputText}: too chatty is an
// annoyance, a suppressed result is data loss.

let globalQuiet = false

/** Set once by the CLI entry point from `parseGlobalFlags` (see policy above). */
export function setQuiet(quiet: boolean): void {
  globalQuiet = quiet
}

/** Whether informational output is currently suppressed. Per-call `options.quiet` overrides the global flag. */
export function isQuiet(options?: OutputOptions): boolean {
  return options?.quiet ?? globalQuiet
}

/**
 * Write a line of PRIMARY human-readable output to stdout; never suppressed. Use
 * {@link outputInfo} for progress/confirmations and {@link outputError}/{@link exit}
 * for errors. `--json` is NOT handled here: a command supporting it builds a result
 * and calls {@link outputJson}; one that cannot should say so, not emit prose.
 */
export function outputText(text: string): void {
  process.stdout.write(text + '\n')
}

/**
 * Write an INFORMATIONAL line to stdout — suppressed by `--quiet`.
 *
 * Use for progress, confirmations of requested mutations, banners, hints,
 * and summary footers (see the --quiet policy above). Pass the command's
 * `flags` when in scope so behaviour is explicit and testable in-process;
 * the global flag set by the entry point covers call sites that don't.
 */
export function outputInfo(text: string, options?: OutputOptions): void {
  if (isQuiet(options)) return
  process.stdout.write(text + '\n')
}

/**
 * Write an error line to stderr. NEVER suppressed — `--quiet` silences
 * chatter, not failures. Prefer {@link exit} when the command terminates
 * immediately; use this when it reports and continues (or exits later).
 */
export function outputError(text: string): void {
  process.stderr.write(text + '\n')
}

/** Exit with code. 0 = success, 1 = error, 2 = no results. */
export function exit(code: 0 | 1 | 2, message?: string): never {
  if (message) process.stderr.write(message + '\n')
  process.exit(code)
}
