/**
 * Argument parsing and bind planning for `plur ui`.
 *
 * The server itself lives in `@plur-ai/ui/server` — the DeepSeek Harness
 * plugin serves the same viewer, and one implementation beats two that drift.
 * What stays here is the part that is genuinely CLI-shaped: the flags, and
 * what they mean for the socket, the printed URL and the `Host` allowlist.
 * That translation is pure, so it is tested without a socket.
 *
 * @module
 */
import { isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { canonicalHostName, isLoopbackName, isUnspecifiedName } from '@plur-ai/ui/server'
export { createUiServer, LINKS, type UiServerOptions } from '@plur-ai/ui/server'

/** Options accepted by `plur ui`. */
export interface UiArgs {
  port: number
  /** The bind address or hostname, canonical, without IPv6 brackets. */
  host: string
  /** Extra names the viewer answers to, canonical, without IPv6 brackets. */
  allowHosts: string[]
  open: boolean
}

const DEFAULT_PORT = 7777

/**
 * Validate one host-shaped flag value and fold it to canonical form.
 *
 * The value ends up in three places that must agree: `listen()`, the printed
 * URL, and the `Host` allowlist a browser's request is checked against. So it
 * is folded the way a browser folds a URL host (see `canonicalHostName`), and
 * anything that is not a bare hostname or IP literal is refused with a
 * message naming the mistake — the URL parser would otherwise silently drop a
 * port or a path and bind something the operator did not ask for.
 *
 * @param raw - the flag's value, possibly missing.
 * @param flag - the flag's name, for the error.
 * @returns the canonical name, IPv6 without brackets.
 * @throws when the value is missing or is not a bare hostname or IP literal.
 */
export function parseHostValue(raw: string | undefined, flag: string): string {
  const v = String(raw ?? '').trim()
  // A hostname cannot start with a dash, so a value that does is the next
  // flag: `--host --port 8080` forgot the host, and used to bind `--port`.
  if (v === '' || v.startsWith('-')) throw new Error(`${flag} needs a value`)
  const bracketed = v.match(/^\[([^\]]*)\](.*)$/)
  if (v.startsWith('[') && !bracketed) throw new Error(`${flag}: brackets enclose only an IPv6 literal, got "${v}"`)
  const inner = bracketed ? bracketed[1]! : v
  if (isIPv6(inner) && inner.includes('%')) {
    throw new Error(`${flag}: "${v}" carries a zone id, which no browser can put in a URL. Bind the address without it.`)
  }
  if (bracketed) {
    if (!isIPv6(inner)) throw new Error(`${flag}: brackets enclose only an IPv6 literal, got "${v}"`)
    if (bracketed[2] !== '') throw new Error(`${flag} takes no port — use --port. Nothing may follow the closing bracket in "${v}"`)
  } else if (/[\s/\\?#@%]/.test(v)) {
    throw new Error(`${flag} must be a bare hostname or IP address, got "${v}" — no scheme, path, or credentials`)
  } else if (v.includes(':') && !isIPv6(v)) {
    throw new Error(`${flag} takes no port — use --port. Got "${v}"`)
  }
  const canonical = canonicalHostName(v)
  if (canonical === undefined) throw new Error(`${flag}: "${v}" is not a valid hostname or IP address`)
  return canonical
}

/**
 * Parse `plur ui` arguments.
 *
 * @param args - argv after the command name.
 * @returns the resolved options.
 * @throws when `--port` is not a usable TCP port, or a host value is not a
 *   bare hostname or IP literal.
 */
export function parseUiArgs(args: readonly string[]): UiArgs {
  let port = DEFAULT_PORT
  // Loopback by default, and only widened explicitly: this serves an entire
  // memory store with no authentication, so binding 0.0.0.0 by default would
  // hand it to anyone on the network.
  let host = '127.0.0.1'
  const allowHosts: string[] = []
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
      host = parseHostValue(args[++i], '--host')
      continue
    }
    if (arg === '--allow-host') {
      const name = parseHostValue(args[++i], '--allow-host')
      // No client can carry the unspecified address in Host: a browser will
      // not navigate to it, and the server has nothing to match it against.
      if (isUnspecifiedName(name)) throw new Error(`--allow-host: "${name}" is the unspecified address, not a name a client can use`)
      allowHosts.push(name)
      continue
    }
  }
  return { port, host, allowHosts, open }
}

/** What `plur ui` does with its flags: the socket, the URL, the allowlist. */
export interface ViewerPlan {
  /** Handed to `listen()`. Canonical, no brackets. */
  bind: string
  /** The bind reaches past loopback: warn, and never reveal the folder. */
  widened: boolean
  /**
   * Serve the folder-reveal route. Only on a loopback bind, and only when
   * every `--allow-host` is loopback too — a server that answers to a network
   * name is reachable from the network, whatever it is bound to.
   */
  revealFolder: boolean
  /** Every name the viewer answers to, beyond the built-in loopback set. */
  allowedHosts: string[]
  /** A host a browser can navigate to, brackets included for IPv6. */
  urlHost: string
}

/** Addresses of every interface that is not loopback. */
function interfaceAddresses(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (!a.internal) out.push(a.address)
  }
  return out
}

/**
 * The host a browser can actually navigate to for a given bind.
 *
 * The unspecified address is reachable at every interface but AT none of
 * them: `http://0.0.0.0/` is not a page. Print the loopback address of the
 * same family instead, which the bind always covers. An IPv6 literal is
 * bracketed — `http://::1:7777/` is not a URL, and `new URL()` refuses it.
 */
export function urlHostFor(bind: string): string {
  const h = canonicalHostName(bind) ?? bind
  if (isUnspecifiedName(h)) return h === '::' ? '[::1]' : '127.0.0.1'
  return h.includes(':') ? `[${h}]` : h
}

/**
 * Decide the socket, the URL and the allowlist from the parsed flags.
 *
 * The allowlist is every name this server is legitimately reachable at:
 *
 * - The literal `--host` value, always. It is what the printed URL carries
 *   and therefore what the browser sends — and the server's own built-in set
 *   is deliberately stricter than the classifier here (`localhost.` and
 *   `127.0.0.2` are loopback to bind, and spoof shapes to a header), so the
 *   literal value is the only way those spellings ever pass.
 * - When bound to all interfaces, every interface address. A client on the
 *   network types one of those. Never the unspecified address itself.
 * - Everything from `--allow-host`. A DNS or mDNS name that resolves to this
 *   machine cannot be enumerated from inside it, so the operator vouches for
 *   it explicitly rather than the server trusting any name it is asked for —
 *   trusting one on request is precisely the hole the check closes.
 *
 * @param args - the parsed flags.
 * @param deps - the interface enumerator, injectable for tests.
 * @returns the plan.
 */
export function planViewer(
  args: Pick<UiArgs, 'host' | 'allowHosts'>,
  deps: { interfaces?: () => string[] } = {},
): ViewerPlan {
  const bind = canonicalHostName(args.host) ?? args.host
  const extras = args.allowHosts.map(h => canonicalHostName(h) ?? h)
  const widened = !isLoopbackName(bind)
  const revealFolder = !widened && extras.every(isLoopbackName)
  const names = new Set<string>()
  if (isUnspecifiedName(bind)) {
    for (const a of (deps.interfaces ?? interfaceAddresses)()) {
      const c = canonicalHostName(a)
      // Link-local IPv6 needs a zone id to be reachable, and no browser can
      // put one in a URL, so it can never arrive as a Host header. Listing it
      // would only bury the useful names under a dozen fe80:: entries.
      if (c !== undefined && !isUnspecifiedName(c) && !/^fe[89ab][0-9a-f]:/.test(c)) names.add(c)
    }
  } else {
    names.add(bind)
  }
  for (const e of extras) names.add(e)
  return { bind, widened, revealFolder, allowedHosts: [...names], urlHost: urlHostFor(bind) }
}
