import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
it('EFI-6 every scope is checked and unavailable permission evidence is never healthy', async () => {
  const f = await enterpriseFixture(), scopes = Array.from({ length: 120 }, (_, n) => `project:example/p${n}`)
  let status = 200; const batches: string[][] = []
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/me') return res.end(JSON.stringify({ username: 'fixture', org_id: 'example', scopes, scopes_status: 'ok' }))
    if (req.url === '/api/v1/write-check') {
      let body = ''; for await (const chunk of req) body += chunk
      const selected = JSON.parse(body).scopes; batches.push(selected); res.statusCode = status
      return res.end(JSON.stringify({ results: selected.map((scope: string) => ({ scope, writable: true, review_held: true })) }))
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    f.configure([{ ...f.entry, url, scope: scopes[0], scopes }]); const p = f.open()
    const good = await p.checkServerStores()
    expect(good, 'The configured server must produce a diagnostic result').toHaveLength(1)
    expect(good[0].ok, 'Valid read-back evidence must yield a healthy positive control').toBe(true)
    expect(batches.map(b => b.length), 'All 120 scopes must be checked, in bounded requests').toEqual([50, 50, 20])
    expect(batches.flat(), 'No requested scope may disappear or be substituted').toEqual(scopes)
    status = 404
    const bad = await p.checkServerStores()
    expect(bad[0].ok, 'A server without permission checks must not be reported healthy').toBe(false)
    expect(bad[0].checks.find(c => c.name === 'write-path')?.result, 'Missing evidence must be named as could not check').toBe('could-not-check')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close() }
})
