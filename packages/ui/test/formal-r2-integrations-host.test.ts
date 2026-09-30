/**
 * Formal verification round 2 (R2-Integrations, mcp-integrations#12).
 *
 * 1. `normaliseHostName` is idempotent (its docstring says so, "load-bearing"):
 *    `[[::1]]` → `[::1]` → `::1` broke it.
 * 2. A PRESENT Host that normalises to the empty name (`:80`) is not the
 *    "absent Host" case and is refused; an absent Host is still allowed.
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §7.
 */
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { createUiServer, normaliseHostName } from '../src/server.js'

const ODD = [
  '[[::1]]', '[[::1]]:80', '[[localhost]]', '[::1]', '[::1]:7777', '::1', 'localhost:80', 'LOCALHOST',
  ':80', ':', '[]', '[:]', '[::]', 'a:b:c', '[a]:1', ' [::1] ', '127.0.0.1:0', '',
]

describe('normaliseHostName is idempotent', () => {
  for (const v of ODD) {
    it(JSON.stringify(v), () => {
      const once = normaliseHostName(v)
      expect(normaliseHostName(once)).toBe(once)
    })
  }
  it('good case: ordinary spellings still normalise', () => {
    expect(normaliseHostName('[::1]:7777')).toBe('::1')
    expect(normaliseHostName('LOCALHOST:80')).toBe('localhost')
  })
})

function raw(port: number, host: string | undefined) {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = host === undefined ? {} : { host }
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers, setHost: host !== undefined }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('Host that normalises to the empty name', () => {
  it('":80" and "[[::1]]" are refused; absent and localhost are allowed', async () => {
    const server = createUiServer({ load: async () => [], where: '/tmp/x' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      expect(await raw(port, ':80')).toBe(403)
      expect(await raw(port, `:${port}`)).toBe(403)
      expect(await raw(port, '[[::1]]')).toBe(403)
      expect(await raw(port, undefined)).not.toBe(403)
      expect(await raw(port, `localhost:${port}`)).not.toBe(403)
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })
})
