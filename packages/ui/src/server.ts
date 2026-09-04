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
import { isIPv6 } from 'node:net'
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
   * Extra `Host` values to accept, beyond `localhost`, `127.0.0.1` and `::1`.
   *
   * Every name the operator started the server under belongs here — the
   * literal bind address, the machine's interface addresses when bound to all
   * interfaces, and any name the operator vouched for. It WIDENS the
   * rebinding allowlist; it does not disable the check. Matching is exact
   * after {@link normaliseHostName}, so pass names in the form a browser will
   * send them ({@link canonicalHostName} produces that form).
   *
   * Refused together with {@link UiServerOptions.openPath} when any entry is
   * not loopback: revealing a folder is a desktop action, and a server that
   * answers to a network name is reachable from the network.
   *
   * The earlier shape of this option was a `widened` boolean that skipped the
   * host check entirely, on the reasoning that once the bind is open "any host
   * on the network can connect regardless". That conflates two different
   * threats. Network reachability is about who can open a socket; DNS
   * rebinding is about an OFF-network attacker using a victim's browser as a
   * proxy, and the bind address does not affect it at all. With the check
   * skipped, any site the operator visits could rebind its own domain to this
   * machine and read the whole store cross-origin — the frame-blocking headers
   * do not help, because a rebound fetch is same-origin and needs no frame.
   *
   * Accepting the server's OWN addresses instead keeps both properties: a
   * legitimate client on the local network sends the server's address in
   * `Host` and is allowed; a rebound request carries the attacker's domain and
   * is still refused.
   */
  allowedHosts?: string[]
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
 * Normalise a `Host` header value to a bare comparable name.
 *
 * Lowercases (hostnames are case-insensitive per RFC 7230, and a hand-typed
 * http://LOCALHOST:7777/ should not be refused), strips the port, and unwraps
 * the brackets around an IPv6 literal. Nothing else: this is the strict side
 * of the policy, and `localhost.`, `127.1` or `[localhost]` must NOT fold into
 * something on the allowlist. A browser never sends those; only a hand-built
 * request does, and matching it exactly is the whole defence.
 *
 * IDEMPOTENT, and that is load-bearing rather than tidy: a naive
 * `replace(/:\d+$/, '')` eats the last group of a bare IPv6 address, so
 * normalising `::1` a second time yields `:`. Ports are therefore only stripped
 * where they are unambiguous — after a bracketed IPv6 literal, or from a name
 * containing exactly one colon.
 *
 * Brackets are unwrapped only around a value that contains a colon. RFC 3986
 * reserves the bracket form for IPv6 literals, so `[localhost]` is not a
 * spelling of `localhost` and stays as it is — which matches nothing.
 */
export function normaliseHostName(value: string): string {
  let v = String(value ?? '').trim().toLowerCase()
  const bracketed = v.match(/^\[(.+)\](?::\d+)?$/)
  if (bracketed) return bracketed[1]!.includes(':') ? bracketed[1]! : v
  if ((v.match(/:/g) ?? []).length === 1) v = v.replace(/:\d+$/, '')
  return v
}

/**
 * Fold a bind address or hostname into the form a browser puts in `Host`.
 *
 * FOR THE VALUE OF A `--host`-style flag, not for a `Host` header. The two
 * sides of the policy want opposite strictness: the header side matches
 * exactly, and this side has to predict what a browser will send after it
 * parses `http://<value>:<port>/`. Both go through the WHATWG URL parser, so
 * they agree by construction: `LOCALHOST` → `localhost`, `127.1` and
 * `0x7f000001` → `127.0.0.1`, `::FFFF:127.0.0.1` → `::ffff:7f00:1`,
 * `0:0:0:0:0:0:0:1` → `::1`, a Unicode name → its punycode.
 *
 * Returns `undefined` for anything that is not a bare hostname or IP literal:
 * a scheme, a path, a port, credentials, whitespace, brackets around a
 * non-IPv6 value, an IPv4 octet over 255, or an IPv6 zone id (`fe80::1%en0`),
 * which no browser can put in a URL. Callers that want a specific error for a
 * specific mistake check for it first; this is the final word on validity.
 *
 * IPv6 results come back WITHOUT brackets, so the value compares directly
 * against {@link normaliseHostName} of a header. Bracket it for a URL.
 */
export function canonicalHostName(value: string): string | undefined {
  const v = String(value ?? '').trim()
  if (v === '') return undefined
  const inner = v.match(/^\[(.*)\]$/)?.[1] ?? v
  const literal6 = isIPv6(inner)
  // Brackets around anything but an IPv6 literal is not a hostname.
  if (!literal6 && inner !== v) return undefined
  // The URL parser would silently DROP a port, credentials or a path rather
  // than refuse them, and `%41` would decode to a letter. Refuse first.
  if (!literal6 && /[\s/\\?#@%:[\]]/.test(v)) return undefined
  let url: URL
  try {
    url = new URL(`http://${literal6 ? `[${inner}]` : inner}/`)
  } catch {
    return undefined
  }
  if (url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return undefined
  }
  return url.hostname.replace(/^\[|\]$/g, '')
}

/**
 * Is this value a loopback address or the loopback hostname?
 *
 * FOR CLASSIFYING A BIND ADDRESS (a `--host` flag, `server.address()`, a
 * socket's peer), not for validating a `Host` header. The two want different
 * strictness and conflating them is a bug in both directions: `localhost.` is
 * a perfectly ordinary way to ASK for loopback on the command line, and is
 * also a shape the header policy deliberately refuses as a spoof.
 *
 * Works on the canonical form, so every spelling of loopback classifies the
 * same: `::1`, `[::1]`, `0:0:0:0:0:0:0:1`, `127.0.0.2`, `127.1`, `2130706433`,
 * `0x7f000001`, `::ffff:127.0.0.1`, `LOCALHOST`, `localhost.`. Treating any of
 * them as "wider than loopback" would drop the folder-reveal route and print a
 * network warning for a bind nothing off the machine can reach.
 *
 * The empty string is NOT loopback. Node's `listen(port, '')` binds every
 * interface (`::`), so an empty bind is the widest one there is; classifying
 * it as loopback would hand a folder-reveal route to the network.
 *
 * `sub.localhost` is not classified loopback either: RFC 6761 lets resolvers
 * treat it so, but not every resolver does, and a name that might bind a real
 * interface is treated as if it did. The CLI checks what the socket actually
 * bound afterwards.
 */
export function isLoopbackName(value: string): boolean {
  const n = canonicalHostName(value)
  if (n === undefined) return false
  if (n === 'localhost' || n === 'localhost.') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n)) return true
  if (n === '::1') return true
  // IPv4-mapped 127.0.0.0/8, in the form the URL parser serialises it.
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(n)
}

/**
 * Is this value the unspecified address — "bind every interface"?
 *
 * `0.0.0.0`, `::` (and its long spellings), the IPv4-mapped `::ffff:0.0.0.0`,
 * and the empty string, which Node treats the same way. A server bound here
 * is reachable at every interface address, but never AT this address: no
 * browser navigates to `http://0.0.0.0/`, so it must not appear on an
 * allowlist and must not be printed as a URL.
 */
export function isUnspecifiedName(value: string): boolean {
  if (String(value ?? '').trim() === '') return true
  const n = canonicalHostName(value)
  return n === '0.0.0.0' || n === '::' || n === '::ffff:0:0'
}

/**
 * Is the Host header one of ours? Rebinding arrives with the attacker's.
 *
 * The built-in set stays exactly as strict as it was — `localhost.`,
 * `sub.localhost` and `127.0.0.1.nip.io` remain spoof shapes and are refused.
 * `allowed` adds the names this server was started under, matched exactly.
 * An absent Host (HTTP/1.0, a hand-written request) is allowed: no browser
 * omits it, so it is never the rebinding shape.
 */
function hostIsAllowed(
  req: { headers: Record<string, string | string[] | undefined> },
  allowed: readonly string[] = [],
): boolean {
  const name = normaliseHostName(String(req.headers.host ?? ''))
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '') return true
  return allowed.some(a => normaliseHostName(a) === name)
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
  // A server that answers to a network name is reachable from the network,
  // and revealing a folder is a desktop action. Refuse the combination here,
  // where it is a programming error, rather than at the first request from
  // the LAN, where it is an incident. Loopback-only extras are fine.
  const wide = (opts.allowedHosts ?? []).filter(h => !isLoopbackName(h))
  if (opts.openPath && wide.length > 0) {
    throw new Error(
      `openPath cannot be combined with non-loopback allowedHosts (${wide.join(', ')}): `
      + 'revealing a folder must never be reachable from the network.',
    )
  }
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

      // Rebinding check: catches a DNS-rebound request whose `Host` header
      // carries the attacker's domain. ALWAYS applied — a widened bind adds
      // this server's own addresses to the allowlist rather than disabling the
      // check, because rebinding uses the victim's browser and is unaffected by
      // what the socket is bound to.
      if (!hostIsAllowed(req, opts.allowedHosts)) {
        // Say which name was refused: the operator who typed it is the one
        // reading this, and "only answers to localhost" was wrong the moment
        // the bind could be widened. The allowed names are NOT listed — a
        // rebound page can read this body, and this machine's addresses are
        // not the attacker's to learn.
        const refused = normaliseHostName(String(req.headers.host ?? '')).slice(0, 128)
        res.writeHead(403, headers)
        res.end(errorPage(`Refused: this viewer does not answer to the name "${refused}".`))
        return
      }

      // The one write-shaped route, and it writes nothing: it reveals a folder.
      // A POST rather than a GET so a stray `img` tag on any page in the
      // browser cannot pop a file manager window on the operator's desktop.
      if (url.pathname === '/open-store' && req.method === 'POST' && opts.openPath) {
        // The peer must be on this machine. This is a socket fact, not a
        // header, so it holds however the consumer bound the socket and
        // whatever a client claims in Host or Origin. A rebound browser is
        // local and passes this, which is what the two checks below are for.
        if (!isLoopbackName(req.socket?.remoteAddress ?? '')) {
          res.writeHead(403, headers)
          res.end(errorPage('Refused: the folder can only be opened from this machine.'))
          return
        }
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
