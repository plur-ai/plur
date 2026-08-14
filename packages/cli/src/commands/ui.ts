/**
 * `plur ui` — open the local memory viewer in a browser.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputInfo, outputText } from '../output.js'
import { createUiServer, parseUiArgs } from './ui-server.js'
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

  const server = createUiServer({
    // Reloaded per request, so learning something in another window and
    // refreshing shows it.
    load: async () => (await plur.list()) as unknown as readonly EngramRow[],
    where: String(status.storage_root ?? ''),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${opts.port} is already in use. Try: plur ui --port ${opts.port + 1}`)
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
