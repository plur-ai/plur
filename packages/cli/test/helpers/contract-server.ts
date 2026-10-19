import { createServer } from 'http'

/** Loopback contract for installer orchestration; no external service or model. */
export async function startEnterpriseContract() {
  const state = { token: 'plur_sk_' + 'a'.repeat(32), scopes: ['user:example:member', 'group:example/team'],
    meStatus: 200, discovery: 'ok', saveStatus: 201, deviceRequests: 0, writeChunks: [] as string[][],
    writes: [] as Array<Record<string, any>>, reads: 0, rejectToken: '', malformedWriteCheck: false,
    loseSaveReply: false, meRequests: 0, failDiscovery: false, metadata: false, duringDiscovery: undefined as (() => void) | undefined }
  let url = ''
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : {}
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)) }
    if (req.url === '/api/v1/auth/device') {
      state.deviceRequests++; return send({ device_code: 'fixture-device-code', user_code: 'BCDF-GHJK', verification_uri: url + '/me/device', expires_in: 300, interval: 1 })
    }
    if (req.url === '/api/v1/auth/token') return send({ access_token: state.token, token_type: 'Bearer', username: 'member', key_id: 'fixture-key-id', key_name: 'member — fixture device' })
    const authorization = req.headers.authorization
    if (authorization === `Bearer ${state.rejectToken}` || authorization !== `Bearer ${state.token}`) return send({ error: 'unauthorized' }, 401)
    if (req.url === '/api/v1/me') { state.meRequests++; if (state.meRequests === 2) state.duringDiscovery?.(); return send({ username: 'member', org_id: 'example', personal_scope: 'user:example:member', role: 'developer', scopes: state.scopes,
      scopes_status: state.discovery, gitlab_host: 'git.example.invalid', project_paths: {}, key_expires_at: null,
      ...(state.metadata ? { scope_metadata_status: 'ok', scope_metadata: [{ scope: 'group:example/team', description: 'Team engineering conventions', covers: ['engineering'] }] } : {}),
    }, state.failDiscovery && state.meRequests === 2 ? 503 : state.meStatus) }
    if (req.url === '/api/v1/engrams' && req.method === 'POST') {
      if (state.saveStatus !== 201) return send({ error: 'fixture write refused' }, state.saveStatus)
      const row = { ...body, id: `ENG-SERVER-${String(state.writes.length + 1).padStart(4, '0')}`, status: 'active' }
      state.writes.push(row)
      if (state.loseSaveReply) { req.socket.destroy(); return }
      return send(row, 201)
    }
    if (req.url === '/api/v1/recall') {
      state.reads++; return send({ results: state.writes.filter(row => row.scope === body.scope).map(row => ({ ...row, score: 1 })) })
    }
    if (req.url === '/api/v1/write-check') {
      state.writeChunks.push(body.scopes)
      return send({ results: state.malformedWriteCheck ? [] : body.scopes.map((scope: string) => ({ scope, writable: true, review_held: false })) })
    }
    return send({ engrams: [] })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { state, url, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
