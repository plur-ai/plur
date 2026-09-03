/**
 * `plur ui` — open the local memory viewer in a browser.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputInfo, outputText } from '../output.js'
import { createUiServer, parseUiArgs } from './ui-server.js'
import { isLoopbackName, normaliseHostName } from '@plur-ai/ui/server'
import type { EngramRow } from '@plur-ai/ui'

/** Open a URL in the platform's default browser. Best-effort. */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    // Detached and fully ignored: a browser that writes to our stdout would
    // corrupt --json output, and one that outlives us must not hold the pipe.
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // A headless box has no browser. The URL is printed either way.
  }
}

/**
 * Serve the memory viewer until interrupted.
 *
 * @param args - argv after the command name.
 * @param flags - global CLI flags.
 */
/**
 * Every name this server is legitimately reachable at, for the rebinding
 * allowlist when the bind is widened past loopback.
 *
 * Loopback is always accepted by the server itself, so this only needs to add
 * the addresses a client on the network would actually use. `--host 0.0.0.0`
 * (or `::`) means "all interfaces", so every non-internal interface address
 * counts; any other value is a specific address the operator chose, and is
 * included as given.
 *
 * What is deliberately NOT here: arbitrary hostnames. A DNS name that resolves
 * to this machine cannot be enumerated from inside it, and accepting one on
 * trust is precisely the hole the rebinding check exists to close. An operator
 * fronting the viewer with a real hostname needs a reverse proxy that sets a
 * Host this list contains, which is the same posture every other local service
 * takes.
 */
export function ownHostNames(host: string): string[] {
  const names = new Set<string>()
  const bind = normaliseHostName(host)
  const allInterfaces = bind === '0.0.0.0' || bind === '::' || bind === ''
  if (!allInterfaces) names.add(bind)
  if (allInterfaces) {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (!a.internal) names.add(normaliseHostName(a.address))
      }
    }
  }
  return [...names]
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseUiArgs(args)

  // Read-only: browsing memory must never mutate it, including through a lazy
  // write path such as decay or reindexing.
  const plur = createPlur(flags, { readonly: true })
  const status = await plur.status()

  // Proper classification, not a two-string comparison: ::1, 127.0.0.2,
  // ::ffff:127.0.0.1, LOCALHOST and localhost. are all loopback, and treating
  // any of them as widened would drop the rebinding defence while granting no
  // network reach at all.
  const isLoopback = isLoopbackName(opts.host)
  const server = createUiServer({
    // Reloaded per request, so learning something in another window and
    // refreshing shows it.
    load: async () => (await plur.list()) as unknown as readonly EngramRow[],
    where: String(status.storage_root ?? ''),
    // Reveal folder only on loopback: opening a window on someone's desktop
    // is a poor thing to expose to a network.
    ...(isLoopback ? { openPath: String(status.storage_root ?? '') } : {}),
    // A widened bind WIDENS the rebinding allowlist rather than disabling it.
    // Legitimate clients on the network address this server by one of its own
    // addresses; a rebound browser carries the attacker's domain and is still
    // refused. See ownHostNames().
    ...(isLoopback ? {} : { allowedHosts: ownHostNames(opts.host) }),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${opts.port} is already in use. Try: plur dashboard --port ${opts.port + 1}`)
        : error)
    })
    server.listen(opts.port, opts.host, resolve)
  })

  const url = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}/`
  outputInfo('PLUR Memory', flags)
  outputText(`  ${url}`)
  outputText(`  store: ${status.storage_root}`)
  outputText(`  ${status.engram_count} engrams · Ctrl-C to stop`)
  if (!isLoopback) {
    outputText('')
    outputText(`  WARNING: bound to ${opts.host}. The viewer has no authentication.`)
    outputText('  Anyone on your network can read your entire memory store.')
    outputText('  DNS rebinding risk: any site you visit could read the store through')
    outputText('  your browser. Only run widened on a network you fully control.')
  }

  if (opts.open) openBrowser(url)

  // Hold the process open until the user stops it.
  await new Promise<void>(resolve => {
    const stop = () => { server.close(() => resolve()) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
