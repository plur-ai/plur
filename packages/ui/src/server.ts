/**
 * The viewer's HTTP server.
 *
 * Exported from `@plur-ai/ui/server` rather than the package root: the root
 * entry is pure render functions that a browser bundler can take, and a
 * top-level `node:http` import would break that. Anything Node-only lives here.
 *
 * Two hosts consume this — `plur ui` (the CLI opens it in a browser) and
 * `@plur-ai/dsh` (the `/plur-memory` command inside DeepSeek Harness). They
 * share one implementation so a fix to either reaches both.
 *
 * Node's built-in `node:http` on purpose: the viewer is one route serving one
 * string, and the zero-dependency footprint is worth keeping.
 *
 * @module @plur-ai/ui/server
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { resolveLang, strings } from './i18n.js'
import { renderBrowse, renderPage } from './views.js'
import type { EngramRow } from './query.js'

/** Where to send people who want to help. */
export const LINKS = {
  requestFeature: 'https://github.com/plur-ai/plur/issues/new',
  contribute: 'https://github.com/plur-ai/plur/blob/main/CONTRIBUTING.md',
  github: 'https://github.com/plur-ai/plur',
  website: 'https://plur.ai',
} as const

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
  /**
   * Extra `Host` values to accept, for a bind widened past loopback via
   * `--host` — the machine's own interface addresses and hostnames.
   *
   * The Host check is a DNS-rebinding defence and is NOT dropped when the bind
   * widens. It is tempting to drop it, on the reasoning that anyone on the
   * network can already connect — but that reasoning only covers a LAN-local
   * attacker. A remote attacker with a short-TTL record gets a browser on the
   * operator's LAN to make same-origin requests to this port and read the
   * response; the socket, method and path are identical to a legitimate
   * request, and `Sec-Fetch-Site` reads `same-origin` because the browser
   * believes it. `Host` is the only thing left that differs, and the viewer has
   * no authentication, so a successful rebind is a full read of the store by
   * someone who was never on the network.
   *
   * So the check is widened, not removed: exactly these names, plus loopback.
   * Empty or absent means loopback only.
   */
  allowedHosts?: readonly string[]
}

/** Reveal a directory in the platform's file manager. Best-effort. */
function revealFolder(path: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open'
  try {
    // The path is the store root the host resolved, never request input.
    spawn(command, [path], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // No file manager. The path is on screen either way.
  }
}

/**
 * Is this request from the viewer's own page, rather than another site?
 *
 * Two attacks made this necessary, both demonstrated against the running
 * server:
 *
 *   - CSRF on `POST /open-store`. A cross-origin FORM post is a simple
 *     request with no preflight, so "it is a POST, not an img tag" was not the
 *     protection the code claimed. 25 cross-origin posts produced 25 real
 *     file-manager spawns; a loop is a desktop denial of service. `plur ui`
 *     uses a fixed port, so nothing even has to be guessed.
 *   - DNS rebinding on `GET /`. Binding 127.0.0.1 keeps the network out but
 *     not a browser the attacker already controls: a page on their domain with
 *     a short-TTL record pointing at 127.0.0.1 becomes same-origin and can
 *     read the entire engram store.
 *
 * `Sec-Fetch-Site` is sent by every current browser and is not settable by
 * script. `Host` closes rebinding, because a rebound request still carries the
 * attacker's hostname. Non-browser clients (curl) send neither and are allowed
 * through on GET — they are not the threat, and a terminal user fetching their
 * own viewer should not be blocked.
 */
function isSameOrigin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase().trim()
  if (site !== '') return site === 'same-origin' || site === 'none'
  // No Sec-Fetch-Site. Allowing everything here left the hole open for any
  // browser that does not send it — pre-16.4 WebKit, embedded webviews — and
  // 15 cross-origin POSTs still produced 15 file-manager spawns. `Origin`
  // predates Sec-Fetch-Site by years and IS sent on every cross-origin POST,
  // so an Origin that is present and not ours is a cross-site request whatever
  // the browser's vintage. curl sends neither and is still allowed through.
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = String(req.headers.host ?? '').toLowerCase()
  try {
    return new URL(String(origin)).host.toLowerCase() === host
  } catch {
    return false
  }
}

/**
 * Is this request's `Host` one this server actually answers to?
 * Rebinding arrives with the attacker's.
 *
 * Loopback is always allowed. `allowed` adds the names a widened bind is
 * reachable as — the interface addresses, the hostname, its `.local` form —
 * and nothing else.
 *
 * This is the DNS-rebinding discriminator, and it is the ONLY one available on
 * `GET /`. A rebound request arrives on the same socket, with the same method
 * and path, and (because the browser genuinely believes the origin is the
 * attacker's) a `Sec-Fetch-Site: same-origin` header. Every signal matches a
 * legitimate request except the hostname the attacker had to keep in order for
 * their script to read the response.
 *
 * Matching is EXACT after stripping the port and IPv6 brackets — never a
 * prefix, suffix or substring test. `192.168.1.50.evil.example` contains an
 * allowed name and is not one.
 *
 * @param req - the incoming request, for its `Host` header.
 * @param allowed - additional exact host names to accept, already lowercased.
 * @returns whether the request may be served.
 */
function hostIsAllowed(
  req: { headers: Record<string, string | string[] | undefined> },
  allowed: readonly string[],
): boolean {
  // Case-insensitive: hostnames are, per RFC 7230. Browsers lowercase it, but
  // a proxy or a hand-typed http://LOCALHOST:7777/ should not be refused.
  const host = String(req.headers.host ?? '').toLowerCase()
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '') return true
  return allowed.includes(name)
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
  // Normalised once, not per request: lowercased for the case-insensitive
  // compare, port and IPv6 brackets stripped so a caller passing "[::1]:7777"
  // or "Host.local" still matches, and empties dropped so a stray '' cannot
  // become a wildcard against a missing Host header.
  const allowedHosts: readonly string[] = (opts.allowedHosts ?? [])
    .map(h => String(h).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').trim())
    .filter(h => h.length > 0)

  return createServer((req, res) => {
    void (async () => {
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        // Never let a page listing someone's whole memory land in a disk cache.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // The page loads nothing external; say so.
        // frame-ancestors 'none' keeps the page out of an attacker's iframe,
        // which is the other half of the rebinding story.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      }

      const url = new URL(req.url ?? '/', 'http://localhost')

      // Rebinding check first: it applies to every route, including the read.
      // Widening the bind widens this allowlist; it never disables the check.
      if (!hostIsAllowed(req, allowedHosts)) {
        res.writeHead(403, headers)
        res.end(errorPage(allowedHosts.length > 0
          ? 'Refused: that Host is not one this viewer serves.'
          : 'Refused: this viewer only answers to localhost.'))
        return
      }

      // The one write-shaped route, and it writes nothing: it reveals a folder.
      // A POST rather than a GET so a stray `img` tag on any page in the
      // browser cannot pop a file manager window on the operator's desktop.
      if (url.pathname === '/open-store' && req.method === 'POST' && opts.openPath) {
        if (!isSameOrigin(req)) {
          res.writeHead(403, headers)
          res.end(errorPage('Refused: that request did not come from this page.'))
          return
        }
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

/** A running viewer. */
export interface RunningViewer {
  /** The loopback URL to open. */
  url: string
  /** Stop the server and release the port. */
  close: () => Promise<void>
}

/**
 * Start the viewer on a loopback port and wait until it is accepting.
 *
 * Convenience over {@link createUiServer} for hosts that just want a URL —
 * `port: 0` takes whatever the OS has free, which is what an embedded host
 * should do rather than fighting over a fixed number.
 *
 * Binds `127.0.0.1` unconditionally. The viewer serves an entire memory store
 * with no authentication, so it must never be reachable off the machine.
 *
 * @param opts - the server options, plus an optional fixed port.
 * @returns the URL and a close function.
 */
export async function startViewer(
  opts: UiServerOptions & { port?: number },
): Promise<RunningViewer> {
  const server = createUiServer(opts)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0)
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
}
