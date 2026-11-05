// A local npm registry ("mirror") and an isolated npm configuration, so tests of
// the update check run the real npm against 127.0.0.1 and never the network.
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** ok: serve packuments; 500: answer HTTP 500; hang: never answer; reset: close each connection at once. */
export type MirrorMode = 'ok' | '500' | 'hang' | 'reset'

export interface Mirror {
  /** Registry URL with a trailing slash. */
  url: string
  /** host:port, as the update check names it. */
  host: string
  /** Every request path the mirror received, decoded. */
  requests: string[]
  /** TCP connections accepted (counted in every mode, also `reset`). */
  connections: () => number
  /** Authorization headers received, in order. */
  auth: string[]
  setMode(mode: MirrorMode): void
  close(): Promise<void>
}

/** Serves a packument for each package in `latest` (name → version); 404 otherwise. */
export async function startMirror(latest: Record<string, string>, mode: MirrorMode = 'ok'): Promise<Mirror> {
  let current = mode
  const requests: string[] = []
  const auth: string[] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? '')
    requests.push(path)
    auth.push(String(req.headers.authorization ?? ''))
    if (current === 'hang') return
    if (current === '500') { res.writeHead(500); res.end('boom'); return }
    const name = path.replace(/^\//, '')
    const version = latest[name]
    if (!version) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"Not found"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { name, version } } }))
  })
  let connections = 0
  server.on('connection', (s) => {
    connections++
    if (current === 'reset') { s.destroy(); return }
    sockets.add(s); s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/`,
    host: `127.0.0.1:${port}`,
    requests,
    connections: () => connections,
    auth,
    setMode: (m) => { current = m },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

/** A port on 127.0.0.1 that nothing listens on (connection refused). */
export async function refusedPort(): Promise<number> {
  const s = net.createServer()
  // No host: listening on all interfaces needs no DNS lookup (some tests stub it).
  await new Promise<void>((r) => s.listen(0, () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

export interface NpmSandbox {
  /** A copy of process.env with only this sandbox's npm configuration. */
  env: NodeJS.ProcessEnv
  home: string
  /** Put this sandbox's configuration into process.env; returns the restore. */
  apply(): () => void
  cleanup(): void
}

/**
 * An npm configuration of its own: a temporary HOME with `.npmrc` holding
 * `npmrc`, an empty global npmrc, and none of the npm_config_* variables the
 * test runner inherited (pnpm sets several). `extraEnv` adds variables, e.g. an
 * `npm_config_@plur-ai:registry`.
 */
export function npmSandbox(npmrc: string, extraEnv: Record<string, string> = {}): NpmSandbox {
  const home = mkdtempSync(join(tmpdir(), 'plur-npm-home-'))
  writeFileSync(join(home, '.npmrc'), npmrc)
  writeFileSync(join(home, 'global-npmrc'), '')
  const isNpmVar = (k: string) => /^npm_config_/i.test(k)
  const vars: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: join(home, 'global-npmrc'),
    ...extraEnv,
  }
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!isNpmVar(k) && k !== 'npm_execpath') env[k] = v
  Object.assign(env, vars)
  return {
    env,
    home,
    apply() {
      const saved = { ...process.env }
      for (const k of Object.keys(process.env)) if (isNpmVar(k) || k === 'npm_execpath') delete process.env[k]
      Object.assign(process.env, vars)
      return () => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
        Object.assign(process.env, saved)
      }
    },
    cleanup() { rmSync(home, { recursive: true, force: true }) },
  }
}
