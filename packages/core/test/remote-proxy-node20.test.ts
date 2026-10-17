/**
 * Does the remote store's fetch go through HTTPS_PROXY?
 *
 * Node's built-in fetch reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY only when
 * NODE_USE_ENV_PROXY=1 (or --use-env-proxy) is set when the process STARTS;
 * setting them on process.env later changes nothing. That switch exists from
 * Node 22.21.0 and 24.0.0. Measured with this file's proxy:
 *
 *   Node 20.20.2, 22.20.0               with NODE_USE_ENV_PROXY=1  → direct (proxy unused)
 *   Node 22.21.0, 22.22.2, 24.10, 26.10 with NODE_USE_ENV_PROXY=1  → through the proxy
 *   any of them                          without it                 → direct
 *
 * So Node 20 cannot reach a remote store behind a proxy without a new
 * dependency, and the floor is Node 22 (22.21 or later behind a proxy; on
 * 22.0-22.20 the first case below fails). PLUR's installer puts
 * NODE_USE_ENV_PROXY=1 in each editor's MCP env, which is what these tests
 * reproduce: each case starts a fresh Node with that environment and runs
 * RemoteStore.me() from source (through tsx, as other process tests here do).
 */
import { it, expect, beforeAll, afterAll, beforeEach, describe } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TOKEN = 'proxy-test-token-x7k9'
const TSX = pathToFileURL(createRequire(__filename).resolve('tsx')).href
const REMOTE_STORE = pathToFileURL(join(__dirname, '..', 'src', 'store', 'remote-store.ts')).href

/** A proxy that records what it was asked for and refuses all of it. */
class RecordingProxy {
  /** `host:port` of every CONNECT tunnel requested (https targets). */
  connects: string[] = []
  /** Absolute URL of every plain forwarded request (http targets). */
  forwards: string[] = []
  url = ''
  private server: Server | null = null

  get requests(): number { return this.connects.length + this.forwards.length }
  reset(): void { this.connects = []; this.forwards = [] }

  async start(): Promise<void> {
    const srv = createServer((req, res) => {
      this.forwards.push(req.url ?? '')
      res.writeHead(502)
      res.end()
    })
    srv.on('connect', (req, socket) => {
      this.connects.push(req.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    })
    this.server = srv
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') return reject(new Error('unexpected address'))
        this.url = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const srv = this.server
    if (!srv) return
    srv.closeAllConnections?.()
    await new Promise<void>(resolve => srv.close(() => resolve()))
    this.server = null
  }
}

/**
 * Run `new RemoteStore(url, TOKEN, '').me()` in a fresh Node whose
 * environment carries the proxy settings from its start, as an editor's MCP
 * env does. Resolves with whether me() succeeded.
 */
function meInFreshNode(url: string, env: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  const script = `
    const { RemoteStore } = await import(${JSON.stringify(REMOTE_STORE)})
    try {
      const me = await new RemoteStore(${JSON.stringify(url)}, ${JSON.stringify(TOKEN)}, '').me()
      process.stdout.write(JSON.stringify({ ok: true, detail: me.username }))
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, detail: String(e && e.message) }))
    }
  `
  const base: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[k]) base[k] = process.env[k] as string
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, '--input-type=module', '-e', script], {
      env: { ...base, NODE_USE_ENV_PROXY: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => {
      try { resolve(JSON.parse(out)) } catch { reject(new Error(`child exited ${code}: ${out}${err}`)) }
    })
  })
}

let proxy: RecordingProxy

beforeAll(async () => {
  proxy = new RecordingProxy()
  await proxy.start()
})

afterAll(async () => {
  await proxy.stop()
})

beforeEach(() => proxy.reset())

describe('RemoteStore behind HTTPS_PROXY (Node floor measurement)', () => {
  it('with HTTPS_PROXY set, RemoteStore.me() goes through the proxy (Node 20 and current)', async () => {
    // An https remote: the proxy must be asked for a tunnel to it. The name
    // never resolves, so only a request that went through the proxy is seen.
    await meInFreshNode('https://plur.example.com', { HTTPS_PROXY: proxy.url })
    expect(proxy.connects).toContain('plur.example.com:443')
  }, 30_000)

  it('a host listed in NO_PROXY is reached directly', async () => {
    // The same remote and proxy as the case above; only NO_PROXY differs, so
    // an empty record here is the exclusion working, not the proxy being
    // ignored. (The direct attempt fails: the name does not resolve.)
    const r = await meInFreshNode('https://plur.example.com', { HTTPS_PROXY: proxy.url, NO_PROXY: 'plur.example.com' })
    expect(proxy.requests).toBe(0)
    expect(r.ok).toBe(false)
  }, 30_000)
})
