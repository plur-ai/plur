import { createServer } from 'http'

/** Transport contract for the production CLI/MCP migration proof. Unknown
 * routes are recorded and fail, so an empty catch-all cannot hide a mismatch. */
export async function migrationServer() {
  const oldKey = [JSON.stringify({ alg: 'HS256', typ: 'JWT' }), JSON.stringify({ sub: 'legacy-member' }), 'synthetic-signature'].map(s => Buffer.from(s).toString('base64url')).join('.')
  const state = { key: 'plur_sk_' + 'm'.repeat(32), oldKey, deviceRequests: 0,
    queueOnly: false, writes: [] as Record<string, any>[], recalls: [] as Record<string, any>[], unknown: [] as string[], requests: [] as string[] }
  let url = ''
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const pathname = new URL(req.url!, 'http://localhost').pathname
    state.requests.push(`${req.method} ${pathname}`)
    let bytes = ''; for await (const chunk of req) bytes += chunk
    const body = bytes ? JSON.parse(bytes) : {}
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)) }
    if (pathname === '/api/v1/auth/device') { state.deviceRequests++; return send({ device_code: 'migration-code', user_code: 'BCDF-GHJK', verification_uri: url + '/me/device', expires_in: 300, interval: 1 }) }
    if (pathname === '/api/v1/auth/token') return send({ access_token: state.key, token_type: 'Bearer', username: 'member', key_id: 'migration-key', key_name: 'member — fixture device' })
    const token = req.headers.authorization
    state.requests[state.requests.length - 1] += token === `Bearer ${state.key}` ? ' [new key]' : token === `Bearer ${state.oldKey}` ? ' [old key]' : ' [other key]'
    if (token !== `Bearer ${state.key}` && !(state.queueOnly && token === `Bearer ${state.oldKey}`)) return send({ error: 'unauthorized' }, 401)
    if (pathname === '/api/v1/me') return send({ username: 'member', org_id: 'example', role: 'developer', personal_scope: 'user:example:member',
      scopes: ['user:example:member', 'group:example/team'], scopes_status: 'ok', gitlab_host: 'git.example.invalid', project_paths: {}, key_expires_at: null })
    if (pathname === '/api/v1/engrams' && req.method === 'POST') {
      if (state.queueOnly) return send({ error: 'fixture offline period' }, 503)
      const previous = state.writes.find(row => body.idempotency_key && row.idempotency_key === body.idempotency_key)
      if (previous) return send({ ...previous, deduplicated: true, review_required: false }, 201)
      const row = { ...body, id: `ENG-MIGRATION-${state.writes.length + 1}`, status: 'active', created_at: new Date().toISOString(), confidence_score: 0.8 }
      state.writes.push(row); return send({ ...row, deduplicated: false, review_required: false }, 201)
    }
    if (pathname === '/api/v1/engrams') return send({ engrams: state.writes })
    if (pathname === '/api/v1/recall') {
      state.recalls.push(body)
      const scopes = body.scopes ?? (body.scope ? [body.scope] : [])
      return send({ results: state.writes.filter(row => scopes.includes(row.scope)).map(row => ({ ...row, score: 1 })), mode: 'keyword' })
    }
    if (pathname === '/api/v1/write-check') return send({ results: body.scopes.map((scope: string) => ({ scope, writable: true, review_held: false })) })
    state.unknown.push(`${req.method} ${pathname}`); return send({ error: 'unknown fixture route' }, 404)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { state, url, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
