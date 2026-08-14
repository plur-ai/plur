/**
 * Argument parsing for `plur ui`.
 *
 * The server itself lives in `@plur-ai/ui/server` — the DeepSeek Harness
 * plugin serves the same viewer, and one implementation beats two that drift.
 * What stays here is the part that is genuinely CLI-shaped: flags.
 *
 * @module
 */
export { createUiServer, LINKS, type UiServerOptions } from '@plur-ai/ui/server'

/** Options accepted by `plur ui`. */
export interface UiArgs {
  port: number
  host: string
  open: boolean
}

const DEFAULT_PORT = 7777

/**
 * Parse `plur ui` arguments.
 *
 * @param args - argv after the command name.
 * @returns the resolved options.
 * @throws when `--port` is not a usable TCP port.
 */
export function parseUiArgs(args: readonly string[]): UiArgs {
  let port = DEFAULT_PORT
  // Loopback by default, and only widened explicitly: this serves an entire
  // memory store with no authentication, so binding 0.0.0.0 by default would
  // hand it to anyone on the network.
  let host = '127.0.0.1'
  let open = true

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-open') { open = false; continue }
    if (arg === '--port') {
      const raw = args[++i]
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`--port must be a number between 1 and 65535, got ${String(raw)}`)
      }
      port = parsed
      continue
    }
    if (arg === '--host') {
      const raw = args[++i]
      if (!raw) throw new Error('--host needs a value')
      host = raw
      continue
    }
  }
  return { port, host, open }
}
