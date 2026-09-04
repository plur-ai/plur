/**
 * `plur ui` — open the local memory viewer in a browser.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputInfo, outputText } from '../output.js'
import { createUiServer, parseUiArgs, planViewer } from './ui-server.js'
import { isLoopbackName } from '@plur-ai/ui/server'
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
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseUiArgs(args)

  // Read-only: browsing memory must never mutate it, including through a lazy
  // write path such as decay or reindexing.
  const plur = createPlur(flags, { readonly: true })
  const status = await plur.status()

  // Everything the flags imply — bind, URL, allowlist, whether the folder
  // button exists — is decided in one place, from the canonical form of the
  // value, not from a two-string comparison. See planViewer().
  const plan = planViewer(opts)
  const root = String(status.storage_root ?? '')
  const server = createUiServer({
    // Reloaded per request, so learning something in another window and
    // refreshing shows it.
    load: async () => (await plur.list()) as unknown as readonly EngramRow[],
    where: root,
    // Reveal folder only on loopback: opening a window on someone's desktop
    // is a poor thing to expose to a network.
    ...(plan.revealFolder ? { openPath: root } : {}),
    // The rebinding check stays on whatever the bind. The allowlist is every
    // name this server was started under, so a legitimate client passes and
    // a rebound browser, which carries the attacker's domain, is refused.
    allowedHosts: plan.allowedHosts,
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${opts.port} is already in use. Try: plur dashboard --port ${opts.port + 1}`)
        : error)
    })
    server.listen(opts.port, plan.bind, resolve)
  })

  // The classifier read a name; the socket knows an address. If `localhost`
  // resolved somewhere off this machine (a hosts-file entry, a resolver with
  // opinions), the folder-reveal route was granted on a false premise. Check
  // the ground truth and refuse rather than serve it to the network.
  const bound = server.address()
  const boundAddress = typeof bound === 'object' && bound ? bound.address : ''
  if (plan.revealFolder && !isLoopbackName(boundAddress)) {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    throw new Error(
      `--host ${opts.host} resolved to ${boundAddress || 'an unknown address'}, which is not loopback. `
      + 'Refusing to serve off this machine on a name that claimed otherwise; bind the address explicitly.',
    )
  }

  const url = `http://${plan.urlHost}:${opts.port}/`
  outputInfo('PLUR Memory', flags)
  outputText(`  ${url}`)
  outputText(`  store: ${status.storage_root}`)
  outputText(`  ${status.engram_count} engrams · Ctrl-C to stop`)
  if (plan.widened) {
    outputText('')
    outputText(`  WARNING: bound to ${plan.bind}. The viewer has no authentication.`)
    outputText('  Anyone on your network can read your entire memory store.')
    outputText(`  Answers to Host: ${['localhost', ...plan.allowedHosts].join(', ')}`)
    outputText('  Any other name is refused — that is what stops a DNS-rebound web page.')
    outputText('  Add a name with --allow-host. Only run widened on a network you fully')
    outputText('  control, and stop the viewer when you are done.')
  }

  if (opts.open) openBrowser(url)

  // Hold the process open until the user stops it.
  await new Promise<void>(resolve => {
    const stop = () => { server.close(() => resolve()) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
