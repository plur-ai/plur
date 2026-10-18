/**
 * Proxy settings and the environment a tool's PLUR MCP launch gets (#1638).
 *
 * This env is written into editor configs (Claude Code, Cursor, Codex,
 * OpenCode), files other programs read and users share when asking for help.
 * So it holds only the five keys below: the company CA path and the proxy
 * settings. It never holds a token, never a proxy user name or password, and
 * never a setting that replaces the default trust (SSL_CERT_FILE) or turns TLS
 * verification off (NODE_TLS_REJECT_UNAUTHORIZED). Modelled in
 * spec/formal/PlurSpec/Trust.lean.
 *
 * NODE_USE_ENV_PROXY=1 is what makes Node's fetch use HTTPS_PROXY at all; it
 * works from Node 22.21 and 24.0 (see `envProxySupported`).
 */

export type ProxySettings = { https?: string; http?: string; noProxy?: string }

/** Every key `buildToolMcpEnv` can write. Callers that remove keys they wrote earlier use this set. */
export const TOOL_ENV_KEYS = ['NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'] as const
export type ToolEnvKey = (typeof TOOL_ENV_KEYS)[number]

/** A value that must not be written into a tool config. The message never echoes the value. */
export class LaunchEnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchEnvError'
  }
}

const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined)

/** `--proxy` (https), then HTTPS_PROXY/https_proxy, HTTP_PROXY/http_proxy, NO_PROXY/no_proxy. Empty = absent. */
export function resolveProxy(opts: { flag?: string; env: NodeJS.ProcessEnv }): ProxySettings {
  const { env } = opts
  const out: ProxySettings = {}
  const https = nonEmpty(opts.flag) ?? nonEmpty(env.HTTPS_PROXY) ?? nonEmpty(env.https_proxy)
  const http = nonEmpty(env.HTTP_PROXY) ?? nonEmpty(env.http_proxy)
  const noProxy = nonEmpty(env.NO_PROXY) ?? nonEmpty(env.no_proxy)
  if (https) out.https = https
  if (http) out.http = http
  if (noProxy) out.noProxy = noProxy
  return out
}

/**
 * A proxy address carries credentials when it could hold userinfo. Any `@`
 * counts (a proxy address is scheme, host and port; it has no use for one),
 * and so does a user name or password as Node's own URL parser reads it.
 * Checking a hand-split authority alone missed what the URL parser accepts:
 * leading spaces, tabs, extra or back slashes.
 */
function carriesCredentials(proxy: string): boolean {
  if (proxy.includes('@')) return true
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(proxy) ? proxy : `http://${proxy}`)
    return u.username !== '' || u.password !== ''
  } catch {
    return false
  }
}

/** Whitespace or a control character: never part of a proxy address, and a way to hide one from a check. */
const BAD_PROXY_CHAR = /[\s\x00-\x1f\x7f]/

function checkValue(name: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new LaunchEnvError(`${name} contains a line break or NUL and cannot be written into a tool config.`)
  }
}

/**
 * The keys a tool's MCP entry gets. Absent inputs give absent keys;
 * NODE_USE_ENV_PROXY is "1" only when a proxy is set.
 *
 * Throws LaunchEnvError for a proxy address with a user name or password
 * (it would put a credential into every editor config) and for a value with a
 * line break (it could inject a second setting into a config file).
 */
export function buildToolMcpEnv(opts: { caPath?: string; proxy: ProxySettings }): Record<string, string> {
  const env: Partial<Record<ToolEnvKey, string>> = {}
  const { caPath, proxy } = opts
  for (const [name, value] of [['HTTPS_PROXY', proxy.https], ['HTTP_PROXY', proxy.http]] as const) {
    if (value && BAD_PROXY_CHAR.test(value)) {
      throw new LaunchEnvError(`${name} contains whitespace or a control character and cannot be written into a tool config.`)
    }
    if (value && carriesCredentials(value)) {
      throw new LaunchEnvError(
        `${name} names a proxy with a user name or password. PLUR does not write credentials into editor configs; ` +
          'use a proxy address without them (for example one that authenticates the machine), or set it outside PLUR.',
      )
    }
  }
  if (caPath) {
    checkValue('NODE_EXTRA_CA_CERTS', caPath)
    env.NODE_EXTRA_CA_CERTS = caPath
  }
  if (proxy.https) {
    checkValue('HTTPS_PROXY', proxy.https)
    env.HTTPS_PROXY = proxy.https
  }
  if (proxy.http) {
    checkValue('HTTP_PROXY', proxy.http)
    env.HTTP_PROXY = proxy.http
  }
  if (proxy.noProxy) {
    checkValue('NO_PROXY', proxy.noProxy)
    env.NO_PROXY = proxy.noProxy
  }
  if (proxy.https || proxy.http) env.NODE_USE_ENV_PROXY = '1'
  return env as Record<string, string>
}

/**
 * Whether this Node honours NODE_USE_ENV_PROXY=1: 22.21+ on the 22 line, and
 * 24.0+ (measured: 22.20 and 20.x ignore HTTPS_PROXY; 23 is end-of-life and
 * never had it). Same rule as `embeddingNetworkHint` in commands/doctor.ts.
 */
export function envProxySupported(nodeVersion: string): boolean {
  const [major, minor] = nodeVersion.replace(/^v/, '').split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 21)
}
