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

/** Write JSON to stdout. */
export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n')
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
