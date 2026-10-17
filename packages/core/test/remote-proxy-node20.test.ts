/**
 * Measurement: does the remote store's fetch go through HTTPS_PROXY?
 *
 * Node's built-in fetch (undici-backed) does not read HTTPS_PROXY from the
 * environment on its own in Node 20 or 22. The fix requires undici 8.x
 * (EnvHttpProxyAgent / ProxyAgent), which demands Node >=22.19.0 — so Node 20
 * cannot support it without adding a runtime dependency.
 *
 * Measured result on Node 20 and 22: RED (proxy receives 0 requests; fetch
 * bypasses the proxy and connects directly to the target).
 * Node 20 is therefore no longer supported (engines.node ">=22").
 *
 * The it.fails() marks document the desired end-state; remove them once
 * proxy support is wired into RemoteStore.
 */
import { it, expect, beforeAll, afterAll, afterEach, describe } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { connect as netConnect } from 'node:net'
import { RemoteStore } from '../src/store/remote-store.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'proxy-test-token-x7k9'

// ---------------------------------------------------------------------------
// Minimal in-process HTTP+CONNECT counting proxy (no forwarding needed).
//
// Counts every connection attempt so tests can assert whether fetch routed
// through the proxy or bypassed it. Does not forward: the it.fails() test
// only needs the count; the NO_PROXY test expects zero and me() goes direct.
// ---------------------------------------------------------------------------

class CountingProxy {
  /** Total connections received (plain HTTP or CONNECT). */
  requests = 0
  url = ''
  private server: Server | null = null

  async start(): Promise<void> {
    const srv = createServer((req: IncomingMessage, res) => {
      this.requests++
      // Refuse the forwarded request so the caller errors cleanly.
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy"' })
      res.end()
    })
    srv.on('connect', (req: IncomingMessage, clientSocket) => {
      this.requests++
      // Acknowledge the tunnel then immediately close — just counting.
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      clientSocket.destroy()
    })
    this.server = srv
    return new Promise<void>((resolve, reject) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') {
          return reject(new Error('unexpected address'))
        }
        this.url = `http://127.0.0.1:${addr.port}`
        resolve()
      })
      srv.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.closeAllConnections?.()
      this.server.close(() => { this.server = null; resolve() })
    })
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let proxy: CountingProxy
let stub: StubServer
let stubUrl: string

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  const { url } = await stub.start()
  stubUrl = url

  proxy = new CountingProxy()
  await proxy.start()
})

afterAll(async () => {
  await stub.stop()
  await proxy.stop()
})

afterEach(() => {
  proxy.requests = 0
  delete process.env.HTTPS_PROXY
  delete process.env.NO_PROXY
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteStore proxy behaviour (Node floor measurement)', () => {
  /**
   * Desired: RemoteStore.me() routes through HTTPS_PROXY.
   * Actual on Node 20 and 22: global fetch bypasses proxy env vars entirely;
   * proxy.requests stays 0 and the expect fails.
   *
   * it.fails() marks the expected gap. Remove it — and the "floor" comment in
   * commit BREAKING/efi-b17 — once proxy support is wired in.
   */
  it.fails('with HTTPS_PROXY set, RemoteStore.me() goes through the proxy (Node 20 and current)', async () => {
    process.env.HTTPS_PROXY = proxy.url
    await new RemoteStore(stubUrl, TOKEN, '').me()
    expect(proxy.requests).toBeGreaterThan(0)
  })

  /**
   * A host listed in NO_PROXY must bypass the proxy.
   * Passes today vacuously (fetch never uses the proxy). Stays as a guard
   * that a future implementation honours NO_PROXY.
   */
  it('a host listed in NO_PROXY is reached directly', async () => {
    process.env.HTTPS_PROXY = proxy.url
    process.env.NO_PROXY = '127.0.0.1'
    await new RemoteStore(stubUrl, TOKEN, '').me()
    expect(proxy.requests).toBe(0)
  })
})
