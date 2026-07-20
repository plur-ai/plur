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
])

/**
 * Strip credential-bearing fields from anything printed as JSON.
 *
 * `StatusResult` embeds the whole `PlurConfig`, including `stores[].token` —
 * live enterprise bearer tokens. Without this, `plur status --json` pipes them
 * into CI logs, pasted issues and agent transcripts. Redaction lives at the
 * output boundary so every present and future JSON command inherits it.
 *
 * `path` tracks the current ancestor chain, not every object ever visited: a
 * DAG is not a cycle, and PlurConfig legitimately shares sub-objects between
 * store entries. Tracking all visited nodes would render the second reference
 * as '[Circular]' and silently drop real config from the output.
 */
export function redactSecrets(value: unknown, path = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  const obj = value as object
  if (path.has(obj)) return '[Circular]'

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
