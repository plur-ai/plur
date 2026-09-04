/**
 * Output formatting for CLI.
 * Detects TTY vs piped, formats as human-readable or JSON.
 */

import { collapseLineTerminatorsOptional } from '@plur-ai/core'

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

// ── --quiet policy (#730) ───────────────────────────────────────────────────
//
// `--quiet` means "suppress non-essential output". "Non-essential" is defined
// here, once, not per command:
//
//   SUPPRESSED  progress lines ("Testing connectivity…"), confirmations of a
//               mutation the user explicitly requested ("Learned: …",
//               "Feedback recorded"), banners/titles, hints and next-step
//               suggestions, summary footers ("Total: 5").
//   PRESERVED   the primary output — the thing the user asked for (recall
//               results, listings, status fields, reports); warnings that the
//               outcome DIFFERS from what was requested (scope demotion,
//               index failure, partial results); errors (stderr, always);
//               exit codes; all `--json` output; hook-* protocol stdout.
//
// Mechanics: the entry point calls {@link setQuiet} once from the parsed
// global flags, so quiet cannot be forgotten by a command that never threads
// options (the failure mode of the pre-#730 design, where only init-remote
// passed flags and the other ~350 call sites silently ignored the flag).
// Call sites still pass `flags` explicitly where available — that keeps
// commands testable in-process without touching module state, and the
// per-call value overrides the global one.
//
// Ambiguous lines default to {@link outputText} (printing): a too-chatty
// `--quiet` is an annoyance, a suppressed result is data loss.

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
 * Write a line of PRIMARY human-readable output to stdout.
 *
 * Never suppressed — this is the thing the user asked for (see the --quiet
 * policy above). For progress/confirmation/decoration lines use
 * {@link outputInfo}; for errors use {@link outputError} or {@link exit}.
 *
 * `--json` is deliberately NOT handled here. There is no correct automatic
 * translation from a line of prose to a machine-readable record, and inventing
 * one per call site is how you end up with output that is neither. A command
 * that supports `--json` builds a result object and calls {@link outputJson};
 * one that cannot should say so rather than emit prose to a caller that asked
 * for JSON.
 */
/**
 * Render a piece of engram text on ONE line of CLI output.
 *
 * Text-mode listings (`plur recall`, `plur forget --search`, `plur tensions`,
 * `plur packs preview`, ...) print one `[id] statement` per line, and an agent
 * running the CLI through a shell reads that output as a tool result. A line
 * terminator inside a statement — from a remote store, a pack, or a row that
 * predates the write-boundary fold — would mint an extra line that looks like
 * an entry the CLI wrote (#940, #1004). Same fold as every other render path.
 *
 * @param value - engram text of any provenance.
 * @returns the text on one line, or '' for nothing.
 */
export function oneLine(value: unknown): string {
  return collapseLineTerminatorsOptional(value) ?? ''
}

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
