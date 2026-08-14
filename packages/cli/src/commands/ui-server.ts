/**
 * The `plur ui` HTTP server.
 *
 * Split from the command itself so it can be tested without spawning a process
 * or opening a browser: the command wires a real store and a real browser
 * launch, this serves pages.
 *
 * Node's built-in `node:http` on purpose — the viewer is one route serving one
 * string, and the CLI's zero-framework dependency footprint is worth keeping.
 *
 * @module
 */
import { createServer, type Server } from 'node:http'
import { renderBrowse, renderPage, type EngramRow } from '@plur-ai/ui'

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

/** Dependencies the server needs, injected so tests need no store. */
export interface UiServerOptions {
  /** Load the engrams to display. Called per request, so a refresh shows new memory. */
  load: () => Promise<readonly EngramRow[]>
  /** Shown beside the page title, e.g. the store path. */
  where: string
}

/** Minimal HTML error page. Escaped: a store path is not trusted markup. */
function errorPage(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return renderPage({
    title: 'PLUR Memory — error',
    body: `<h1 class="page-title">Memory unavailable</h1>
<p class="page-sub">PLUR could not read the store.</p>
<div class="records"><div class="empty">${safe}</div></div>`,
  })
}

/**
 * Build the viewer's HTTP server.
 *
 * One route. Everything else is a 404, and anything other than GET is a 405 —
 * the viewer is read-only and there is nothing else here to reach.
 *
 * @param opts - the store loader and display context.
 * @returns an unstarted server; the caller listens.
 */
export function createUiServer(opts: UiServerOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        // Never let a page listing someone's whole memory land in a disk cache.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // The page loads nothing external; say so.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        'referrer-policy': 'no-referrer',
      }

      if (req.method !== 'GET') {
        res.writeHead(405, { ...headers, allow: 'GET' })
        res.end(errorPage('This viewer is read-only.'))
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/') {
        res.writeHead(404, headers)
        res.end(errorPage('Not found.'))
        return
      }

      try {
        const rows = await opts.load()
        const offset = Number(url.searchParams.get('offset') ?? '0')
        const body = renderBrowse({
          rows,
          query: {
            q: url.searchParams.get('q') ?? undefined,
            scope: url.searchParams.get('scope') ?? undefined,
            offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
          },
          mode: url.searchParams.get('mode') === 'all' ? 'all' : 'top',
          where: opts.where,
        })
        res.writeHead(200, headers)
        res.end(renderPage({ title: 'PLUR Memory', body }))
      } catch (error: unknown) {
        res.writeHead(500, headers)
        res.end(errorPage(error instanceof Error ? error.message : String(error)))
      }
    })()
  })
}
