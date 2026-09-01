/**
 * `plur ui` — open the local memory viewer in a browser.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { networkInterfaces, hostname } from 'node:os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputInfo, outputText } from '../output.js'
import { createUiServer, parseUiArgs } from './ui-server.js'
import type { EngramRow } from '@plur-ai/ui'

/**
 * The `Host` values this machine is legitimately reachable as on a widened bind.
 *
 * Every non-internal address on every interface, plus the hostname and its
 * mDNS `.local` form — which is how a phone or a laptop on the same network
 * actually addresses it. `0.0.0.0` and `::` are not included as literals: they
 * mean "every interface", so the interface addresses themselves are the real
 * answer and a client never sends `Host: 0.0.0.0`.
 *
 * This is an allowlist, so it must stay tight. Anything not here is refused,
 * which is what keeps a rebound `Host: evil.example` out.
 *
 * @param bindHost - the address passed to `--host`.
 * @returns lowercased host names to accept in addition to loopback.
 */
function localHostNames(bindHost: string): string[] {
  const names = new Set<string>()
  const wildcard = bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '*'
  if (!wildcard) names.add(bindHost.toLowerCase())

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      // `internal` is loopback, already allowed unconditionally.
      if (!address.internal) names.add(address.address.toLowerCase())
    }
  }

  const host = hostname().toLowerCase()
  if (host) {
    names.add(host)
    // Bonjour/Avahi answer `<name>.local`; a browser sends exactly that.
    names.add(host.endsWith('.local') ? host : `${host}.local`)
  }
  return [...names]
}

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
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseUiArgs(args)

  // Read-only: browsing memory must never mutate it, including through a lazy
  // write path such as decay or reindexing.
  const plur = createPlur(flags, { readonly: true })
  const status = await plur.status()

  const isLoopback = opts.host === '127.0.0.1' || opts.host === 'localhost'

  const server = createUiServer({
    // Reloaded per request, so learning something in another window and
    // refreshing shows it.
    load: async () => (await plur.list()) as unknown as readonly EngramRow[],
    where: String(status.storage_root ?? ''),
    // Loopback only. Revealing a folder is harmless locally and rude remotely.
    ...(isLoopback ? { openPath: String(status.storage_root ?? '') } : {}),
    // A widened bind WIDENS the Host allowlist to the names this machine is
    // actually reachable as. It does not disable the check: dropping it would
    // leave `GET /` — which renders the whole store, with no authentication —
    // answerable to a DNS-rebound request carrying an attacker's domain, from
    // an attacker who never had to be on the network. See UiServerOptions.
    ...(isLoopback ? {} : { allowedHosts: localHostNames(opts.host) }),
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
  if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
    outputText('')
    outputText(`  WARNING: bound to ${opts.host}. The viewer has no authentication —`)
    outputText('  anyone who can reach this port can read your entire memory store.')
  }

  if (opts.open) openBrowser(url)

  // Hold the process open until the user stops it.
  await new Promise<void>(resolve => {
    const stop = () => { server.close(() => resolve()) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
