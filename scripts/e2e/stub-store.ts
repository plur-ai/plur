/**
 * Localhost team store for the Windows fresh-install e2e
 * (.github/workflows/e2e-windows-fresh-install.yml). Wraps the in-repo
 * StubServer (packages/core/test/helpers/stub-server.ts) without editing it:
 *
 *   - GET /api/v1/me advertises `feedback.source` and the e2e scope, so the
 *     auto-rate path sends `source: 'auto'` feedback here (#1318);
 *   - POST /api/v1/recall answers from the engrams actually stored here (the
 *     stub only serves a fixed `recallRows` list) — what a real store does;
 *   - GET /__e2e/state (no auth, localhost only) reports what the store has
 *     received: engrams, feedback bodies and call counts, for the assertions.
 *
 * Run: node --experimental-transform-types scripts/e2e/stub-store.ts
 * The token comes from PLUR_E2E_TOKEN (a localhost test value, never a real
 * credential). Prints one line, `E2E_STUB_URL=<url>`, once listening.
 */
import { StubServer } from '../../packages/core/test/helpers/stub-server.ts'
import type { IncomingMessage, ServerResponse, Server } from 'http'
import { Readable } from 'stream'

const token = process.env.PLUR_E2E_TOKEN
if (!token) {
  process.stderr.write('PLUR_E2E_TOKEN is not set\n')
  process.exit(1)
}
const SCOPE = process.env.PLUR_E2E_SCOPE ?? 'group:e2e/test'

const stub = new StubServer(token)
stub.setMe({ username: 'e2e', org_id: 'e2e', role: 'developer', scopes: [SCOPE], capabilities: ['feedback.source'] })
const { url } = await stub.start()

// The stub keeps its engrams and handler private; reach them without editing it.
const internals = stub as unknown as {
  server: Server
  engrams: Map<string, { id: string; scope: string; status: string; data: Record<string, unknown> }>
  handleRequest(req: IncomingMessage, res: ServerResponse): void
}
const original = internals.handleRequest.bind(stub)
const recallBodies: unknown[] = []

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3))
}

internals.server.removeAllListeners('request')
internals.server.on('request', (req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? '/', url).pathname
  if (req.method === 'GET' && path === '/__e2e/state') {
    const body = JSON.stringify({
      engrams: [...internals.engrams.values()].map(e => ({ id: e.id, scope: e.scope, status: e.status, statement: e.data.statement, feedback_signals: e.data.feedback_signals })),
      feedbackBodies: stub.feedbackBodies,
      meCalls: stub.meCalls,
      appendCalls: stub.appendCalls,
      recallCalls: stub.recallCalls,
      getByIdCalls: stub.getByIdCalls,
      recallBodies: recallBodies.slice(-20),
    })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
    return
  }
  if (req.method === 'POST' && path === '/api/v1/recall') {
    // Serve recall from the stored rows: every active row in a requested
    // scope, scored by word overlap with the query (floor 0.05). The body is
    // peeked here and replayed to the stub unchanged.
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* the stub answers {} too */ }
      recallBodies.push({ query: body.query, scopes: body.scopes })
      const scopes = Array.isArray(body.scopes) ? body.scopes as string[] : [SCOPE]
      const q = words(String(body.query ?? ''))
      stub.recallRows = [...internals.engrams.values()]
        .filter(e => e.status === 'active' && scopes.includes(e.scope))
        .map(e => {
          const w = words(String(e.data.statement ?? ''))
          const hit = [...w].filter(x => q.has(x)).length
          return { e, score: w.size ? hit / w.size : 0 }
        })
        // Like a vector search, every row in scope ranks; overlap orders them.
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(r => ({ id: r.e.id, scope: r.e.scope, status: r.e.status, ...r.e.data, score: Math.max(0.05, Math.min(1, r.score)) }))
      const replay = Object.assign(Readable.from([Buffer.concat(chunks)]), { headers: req.headers, method: req.method, url: req.url })
      original(replay as unknown as IncomingMessage, res)
    })
    return
  }
  original(req, res)
})

process.stdout.write(`E2E_STUB_URL=${url}\n`)
const stop = () => { void stub.stop().then(() => process.exit(0)) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
