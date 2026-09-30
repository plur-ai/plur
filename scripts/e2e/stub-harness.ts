/**
 * E2E harness around the in-repo StubServer (packages/core/test/helpers/stub-server.ts).
 *
 * Used by the fresh-install end-to-end check (docs/audits/2026-09-30-fresh-install-macos.md).
 * It does not change the stub. It only:
 *   - starts it on 127.0.0.1 with a token read from $E2E_TOKEN_FILE (never printed),
 *   - makes /api/v1/me advertise the scope under test and the `feedback.source`
 *     capability, so the capability-gated auto-rate path is exercised,
 *   - appends one JSON line per request to $E2E_STUB_LOG (method, path, status,
 *     and for writes the body the stub recorded). The Authorization header is
 *     never logged,
 *   - writes the base url to $E2E_URL_FILE.
 *
 * Run: E2E_TOKEN_FILE=... E2E_STUB_LOG=... E2E_URL_FILE=... E2E_SCOPE=group:e2e/test \
 *      packages/core/node_modules/.bin/tsx scripts/e2e/stub-harness.ts
 * Never point anything at a production or remote store from this script.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { StubServer } from '../../packages/core/test/helpers/stub-server.js'

const tokenFile = process.env.E2E_TOKEN_FILE
const logFile = process.env.E2E_STUB_LOG
const urlFile = process.env.E2E_URL_FILE
const scope = process.env.E2E_SCOPE ?? 'group:e2e/test'
if (!tokenFile || !logFile || !urlFile) {
  console.error('E2E_TOKEN_FILE, E2E_STUB_LOG and E2E_URL_FILE are required')
  process.exit(2)
}
const token = readFileSync(tokenFile, 'utf8').trim()

const stub = new StubServer(token)
stub.setMe({
  username: 'e2e-user',
  org_id: 'e2e',
  role: 'developer',
  scopes: [scope],
  capabilities: ['feedback.source'],
})

// Optional seed: a GET /api/v1/engrams response saved from an earlier run of
// this harness, so a restart keeps the rows it already accepted.
const seedFile = process.env.E2E_SEED
if (seedFile) {
  const seed = JSON.parse(readFileSync(seedFile, 'utf8')) as { rows: Array<{ id: string; scope: string; status: string; data: Record<string, unknown> }> }
  for (const r of seed.rows) stub.seedEngram(r)
}

// The stub's POST /api/v1/recall serves only `recallRows`, which tests set by
// hand. For an end-to-end run it must answer from the rows it actually stores,
// as a real server does: every active stored row in a requested scope, in the
// top-level row shape the recall envelope uses. (No ranking: the test store
// holds a handful of rows.)
const refreshRecallRows = (requestedScopes: string[] | null) => {
  const all = Array.from(((stub as any).engrams as Map<string, any>).values())
  stub.recallRows = all
    .filter(e => e.status === 'active' && (!requestedScopes || requestedScopes.includes(e.scope)))
    .map(e => ({ ...e.data, id: e.id, scope: e.scope, status: e.status, score: 0.9 }))
}

const log = (entry: Record<string, unknown>) =>
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')

// Wrap the request handler: the stub's server calls `this.handleRequest` at
// request time, so an instance property takes effect without editing the stub.
const s = stub as any
const original = s.handleRequest.bind(stub)
s.handleRequest = (req: IncomingMessage, res: ServerResponse) => {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0]
  const query = (req.url ?? '').includes('?') ? (req.url ?? '').split('?')[1] : undefined
  const authOk = req.headers.authorization === `Bearer ${token}`
  const feedbackBefore = stub.feedbackBodies.length
  const appendBefore = stub.appendCalls
  if (method === 'POST' && path === '/api/v1/recall') {
    // Scopes come in the body, which the stub reads; serve every requested
    // scope this harness knows (the one under test).
    refreshRecallRows([scope])
  }
  res.on('finish', () => {
    const entry: Record<string, unknown> = { method, path, status: res.statusCode, auth: authOk ? 'valid' : 'invalid' }
    if (query) entry.query = query
    if (method === 'POST' && path === '/api/v1/engrams' && stub.appendCalls > appendBefore && stub.lastAppendBody) {
      const b = stub.lastAppendBody as Record<string, unknown>
      entry.body = { statement: b.statement, scope: b.scope, domain: b.domain, type: b.type }
      entry.idempotency_key = stub.lastAppendIdempotencyKey
    }
    if (/\/feedback$/.test(path) && stub.feedbackBodies.length > feedbackBefore) {
      entry.body = stub.feedbackBodies[stub.feedbackBodies.length - 1]
    }
    if (method === 'POST' && path === '/api/v1/recall') {
      entry.served_ids = stub.recallRows.map((r: any) => r.id)
      entry.request = stub.lastRecallBody ? { scopes: (stub.lastRecallBody as any).scopes, query: (stub.lastRecallBody as any).query } : undefined
    }
    log(entry)
  })
  original(req, res)
}

// E2E_PORT: listen on a fixed port (a restart keeps the url registered in
// config.yaml). The stub's own start() always picks a random port, so this
// does the same thing it does, on the given port.
const fixedPort = process.env.E2E_PORT ? parseInt(process.env.E2E_PORT, 10) : 0
const start = (): Promise<{ url: string }> => {
  if (!fixedPort) return stub.start()
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => s.handleRequest(req, res))
    s.server = server
    server.listen(fixedPort, '127.0.0.1', () => {
      s.port = fixedPort
      resolve({ url: `http://127.0.0.1:${fixedPort}` })
    })
    server.on('error', reject)
  })
}

void (async () => {
  const { url } = await start()
  writeFileSync(urlFile, url + '\n')
  log({ event: 'started', url, scope, capabilities: ['feedback.source'] })
  console.log(`stub listening at ${url} (scope ${scope}; token not shown)`)
})()

const shutdown = async () => { await stub.stop(); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
