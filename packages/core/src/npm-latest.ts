/**
 * Asks the user's own npm which version a package's `latest` tag names, so the
 * registry, a scoped `@plur-ai:registry` mirror, the proxy, the CA and the token
 * are the ones `npm install` uses. Runs npm-cli.js with process.execPath, never
 * a bare `npm`. Three npm defaults are overridden: retries (about 70 s on a dead
 * registry), the cache (npm answers from it when the registry is unreachable,
 * reporting an old version as current; a fresh temp cache is used and removed)
 * and npm's own update notifier. Never throws; a failure names only the
 * registry's host[:port], never a URL that could carry credentials.
 */

import { execFile } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, delimiter, dirname, join } from 'path'

export type NpmLatestResult =
  | { state: 'ok'; version: string }
  | { state: 'missing'; registry: string; reason: string }
  | { state: 'unreachable'; registry: string; reason: string; connectFailure: boolean }
  | { state: 'no-npm'; registry: string; reason: string }

/** Shown when npm's answer names no registry URL. */
export const UNKNOWN_REGISTRY = 'the configured npm registry'

/** One exact version, as npm prints it: never a range, a tag or an empty answer. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * The npm-cli.js that belongs to this Node: the npm that started this process,
 * the file beside Node, the `npm` link beside Node resolved to its script
 * (Homebrew keeps npm outside the Cellar's lib), then each `npm` on PATH
 * resolved the same way. Null when none is found.
 */
export function resolveNpmCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): string | null {
  const started = env.npm_execpath
  if (started && basename(started) === 'npm-cli.js' && existsSync(started)) return started
  const nodeDir = dirname(execPath)
  const beside = platform === 'win32'
    ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(beside)) return beside
  if (platform !== 'win32') {
    for (const dir of [nodeDir, ...(env.PATH ?? '').split(delimiter).filter(Boolean)]) {
      try {
        const script = realpathSync(join(dir, 'npm'))
        if (basename(script) === 'npm-cli.js') return script
      } catch { /* not here */ }
    }
  }
  return null
}

/** host[:port] of the first URL in `text`, never userinfo or path. */
export function registryHost(text: string): string | null {
  const m = /https?:\/\/[^\s'"]+/.exec(text)
  if (!m) return null
  try {
    return new URL(m[0]).host || null
  } catch {
    return null
  }
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|EPROTO|SSL/i

/** Classify npm's `--json` error. Exported for tests. */
export function classifyNpmError(pkg: string, code: string, summary: string): NpmLatestResult {
  const registry = registryHost(summary) ?? UNKNOWN_REGISTRY
  if (code === 'E404') return { state: 'missing', registry, reason: `it has no ${pkg}` }
  const http = /^E(\d{3})$/.exec(code)
  if (http) {
    const n = Number(http[1])
    const reason = n === 401 || n === 403
      ? `it answered HTTP ${n}: not authorised, check the token for that registry`
      : `it answered HTTP ${n}`
    return { state: 'unreachable', registry, reason, connectFailure: false }
  }
  let reason: string
  if (code === 'ECONNREFUSED') reason = 'connection refused'
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') reason = 'host not found'
  else if (code === 'ETIMEDOUT' || /timeout/i.test(summary)) reason = 'timed out'
  else if (code === 'ECONNRESET') reason = 'connection reset'
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') reason = 'network unreachable'
  else if (TLS_CODES.test(code) || /certificate/i.test(summary)) reason = 'TLS certificate not trusted, check cafile / strict-ssl'
  else if (code === 'ENOTCACHED') reason = 'npm is set to offline'
  else return { state: 'unreachable', registry, reason: code ? `npm error ${code}` : 'npm gave no answer', connectFailure: false }
  return { state: 'unreachable', registry, reason, connectFailure: true }
}

export interface NpmLatestOptions {
  /** npm's own fetch timeout. The child is killed 5 s after it. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Override the npm script (tests). */
  npmCli?: string | null
}

/** What npm's `latest` tag names for `pkg`, through the user's npm configuration. */
export function npmLatest(pkg: string, opts: NpmLatestOptions = {}): Promise<NpmLatestResult> {
  const timeoutMs = opts.timeoutMs ?? 3000
  const env = opts.env ?? process.env
  const npmCli = opts.npmCli !== undefined ? opts.npmCli : resolveNpmCli(env)
  if (!npmCli) {
    return Promise.resolve({ state: 'no-npm', registry: UNKNOWN_REGISTRY, reason: 'npm was not found beside this Node' })
  }
  let cache: string | null = null
  try {
    cache = mkdtempSync(join(tmpdir(), 'plur-npm-view-'))
  } catch {
    // No temp dir: still never fall back to npm's own cache (stale answers).
    return Promise.resolve({ state: 'unreachable', registry: UNKNOWN_REGISTRY, reason: 'no temporary directory for npm', connectFailure: false })
  }
  const args = [
    npmCli, 'view', `${pkg}@latest`, 'version', '--json',
    '--fetch-retries=0', `--fetch-timeout=${timeoutMs}`, '--update-notifier=false', `--cache=${cache}`,
  ]
  return new Promise<NpmLatestResult>((resolve) => {
    execFile(process.execPath, args, { env, timeout: timeoutMs + 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      try { if (cache) rmSync(cache, { recursive: true, force: true }) } catch { /* best effort */ }
      const out = String(stdout ?? '').trim()
      let parsed: unknown
      try { parsed = out ? JSON.parse(out) : undefined } catch { parsed = undefined }
      if (!err) {
        const v = typeof parsed === 'string' ? parsed : Array.isArray(parsed) ? parsed[parsed.length - 1] : undefined
        if (typeof v === 'string' && EXACT_VERSION.test(v)) return resolve({ state: 'ok', version: v })
        return resolve({ state: 'unreachable', registry: UNKNOWN_REGISTRY, reason: 'npm did not name one version as latest', connectFailure: false })
      }
      const e = (parsed as { error?: { code?: unknown; summary?: unknown } } | undefined)?.error
      if (e) return resolve(classifyNpmError(pkg, String(e.code ?? ''), String(e.summary ?? '')))
      if ((err as { killed?: boolean }).killed) {
        return resolve({ state: 'unreachable', registry: UNKNOWN_REGISTRY, reason: 'timed out', connectFailure: true })
      }
      return resolve({ state: 'unreachable', registry: UNKNOWN_REGISTRY, reason: 'npm could not be run', connectFailure: false })
    })
  })
}
