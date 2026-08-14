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
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { renderBrowse, renderPage, resolveLang, strings, type EngramRow } from '@plur-ai/ui'

/** Where to send people who want to help. */
const LINKS = {
  requestFeature: 'https://github.com/plur-ai/plur/issues/new',
  contribute: 'https://github.com/plur-ai/plur/blob/main/CONTRIBUTING.md',
  github: 'https://github.com/plur-ai/plur',
  website: 'https://plur.ai',
} as const

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
  /**
   * Absolute path to reveal when the operator clicks Open folder.
   *
   * Omitted, the button is not rendered. Bound only on loopback: opening a
   * window on someone's desktop is a poor thing to expose to a network.
   */
  openPath?: string
}

/** Reveal a directory in the platform's file manager. Best-effort. */
function revealFolder(path: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open'
  try {
    // The path is the store root this process resolved, never request input.
    spawn(command, [path], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // No file manager. The path is on screen either way.
  }
}

/** Minimal HTML error page. Escaped: a store path is not trusted markup. */
function errorPage(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return renderPage({
    title: 'PLUR Memory — error',
    body: `<header class="hero"><h1 class="hero-title">Memory unavailable</h1>
<p class="hero-sub">PLUR could not read the store.</p></header>
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

      const url = new URL(req.url ?? '/', 'http://localhost')

      // The one write-shaped route, and it writes nothing: it reveals a folder.
      // A POST rather than a GET so a stray `img` tag on any page in the
      // browser cannot pop a file manager window on the operator's desktop.
      if (url.pathname === '/open-store' && req.method === 'POST' && opts.openPath) {
        revealFolder(opts.openPath)
        const back = url.searchParams.get('lang') === 'zh' ? '/?lang=zh' : '/'
        res.writeHead(303, { ...headers, location: back })
        res.end()
        return
      }

      if (req.method !== 'GET') {
        res.writeHead(405, { ...headers, allow: 'GET' })
        res.end(errorPage('This viewer is read-only.'))
        return
      }
      if (url.pathname !== '/') {
        res.writeHead(404, headers)
        res.end(errorPage('Not found.'))
        return
      }

      try {
        const rows = await opts.load()
        const offset = Number(url.searchParams.get('offset') ?? '0')
        // An explicit ?lang wins; otherwise follow the browser's own preference,
        // so a Chinese-locale machine opens in Chinese without being asked.
        const lang = resolveLang(url.searchParams.get('lang') ?? req.headers['accept-language'])
        const body = renderBrowse({
          lang,
          rows,
          query: {
            q: url.searchParams.get('q') ?? undefined,
            scope: url.searchParams.get('scope') ?? undefined,
            offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
          },
          mode: url.searchParams.get('mode') === 'all' ? 'all' : 'top',
          where: opts.where,
          links: { ...LINKS, ...(opts.openPath ? { openFolder: '/open-store' } : {}) },
        })
        res.writeHead(200, headers)
        res.end(renderPage({ title: strings(lang).docTitle, body, lang }))
      } catch (error: unknown) {
        res.writeHead(500, headers)
        res.end(errorPage(error instanceof Error ? error.message : String(error)))
      }
    })()
  })
}
