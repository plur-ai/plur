/**
 * Adversarial tests for the viewer's Host policy.
 *
 * INVARIANTS UNDER TEST — each `describe` below tries to break one.
 *
 *  I1  A request whose Host is neither built-in loopback (`localhost`,
 *      `127.0.0.1`, `::1`, absent) nor an exact allowlist entry is refused
 *      with 403 and no store content — whatever the method, the path, or the
 *      Sec-Fetch-Site / Origin headers claim, and whatever the allowlist holds.
 *  I2  Brackets are unwrapped only around an IPv6 literal. `[localhost]` and
 *      `[192.168.1.50]` are not spellings of the names inside them.
 *  I3  Allowlist matching is exact after normalisation: no suffix, prefix,
 *      credential, subdomain, or alternative spelling of an allowed name passes.
 *  I4  `createUiServer` refuses `openPath` together with a non-loopback
 *      allowlist entry — at construction, before a socket exists.
 *  I5  `POST /open-store` never spawns a file manager for a peer that is not
 *      on this machine, whatever Host and Origin claim.
 *  I6  `isLoopbackName` classifies every spelling of loopback as loopback and
 *      every spelling of anything else — the empty string and the unspecified
 *      address included — as not loopback.
 *  I7  `canonicalHostName` accepts only bare hostnames and IP literals, and
 *      folds them to the exact string a browser puts in Host.
 */
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import {
  canonicalHostName, createUiServer, isLoopbackName, isUnspecifiedName, normaliseHostName,
} from '../src/server.js'
import type { EngramRow } from '../src/query.js'

const CANARY = 'CANARY-STATEMENT-7f3a'
const ROWS: EngramRow[] = [
  { id: 'ENG-2026-0814-001', statement: CANARY, scope: 'project:acme', status: 'active', activation: { frequency: 4 } },
]

/** A raw request: undici's fetch refuses to set `Host`, which is the whole point. */
function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  connectTo = '127.0.0.1',
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: connectTo, port, path, method, headers }, res => {
      let body = ''
      res.on('data', c => { body += String(c) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function boot(opts: { allowedHosts?: string[]; openPath?: string; bind?: string } = {}) {
  const { bind = '127.0.0.1', ...rest } = opts
  const server = createUiServer({ load: async () => ROWS, where: '/home/victim/.plur', ...rest })
  await new Promise<void>(r => server.listen(0, bind, r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { port, close: () => new Promise<void>(r => server.close(() => r())) }
}

const OWN = '192.168.1.50'
const NAME = 'my-laptop.local'

describe('I1 — an unknown Host is refused whatever else the request says', () => {
  const hostile = [
    'localhost.', 'sub.localhost', 'LOCALHOST.', 'localhost.evil.com', 'evil.com', 'attacker.example',
    '0.0.0.0', '::', '[::]', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.0.0.2',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:0:0:1]',
    'localhost/x', 'http://localhost', 'localhost@evil.com', 'evil.com@localhost', ' evil.com ',
    `${OWN}.evil.com`, `evil.com.${OWN}`,
  ]

  it('GET / with the fetch-metadata a rebound browser sends — 403, no store content', async () => {
    const h = await boot({ allowedHosts: [OWN] })
    try {
      for (const host of hostile) {
        for (const site of ['none', 'same-origin', 'cross-site']) {
          const r = await raw(h.port, 'GET', '/', { host: `${host}:${h.port}`, 'sec-fetch-site': site })
          expect(r.status, `${host} / ${site}`).toBe(403)
          expect(r.body, host).not.toContain(CANARY)
        }
      }
    } finally { await h.close() }
  })

  it('without a port suffix, and on every route and method', async () => {
    const h = await boot({ allowedHosts: [OWN] })
    try {
      for (const host of hostile) {
        for (const [method, path] of [['GET', '/'], ['GET', '/?mode=all'], ['POST', '/open-store'], ['HEAD', '/'], ['OPTIONS', '/']]) {
          const r = await raw(h.port, method!, path!, { host })
          expect(r.status, `${method} ${path} ${host}`).toBe(403)
          expect(r.body, host).not.toContain(CANARY)
        }
      }
    } finally { await h.close() }
  })

  it('an empty allowlist and an absent allowlist behave the same', async () => {
    for (const allowedHosts of [undefined, []]) {
      const h = await boot(allowedHosts ? { allowedHosts } : {})
      try {
        for (const host of hostile) {
          expect((await raw(h.port, 'GET', '/', { host })).status, host).toBe(403)
        }
        for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST', `localhost:${h.port}`, `[::1]:${h.port}`, 'localhost:80']) {
          expect((await raw(h.port, 'GET', '/', { host })).status, host).toBe(200)
        }
      } finally { await h.close() }
    }
  })

  it('a 403 names the refused Host but never lists the allowed ones', async () => {
    const h = await boot({ allowedHosts: [OWN, NAME] })
    try {
      const r = await raw(h.port, 'GET', '/', { host: 'attacker.example', 'sec-fetch-site': 'none' })
      expect(r.status).toBe(403)
      expect(r.body).toContain('attacker.example')
      expect(r.body).not.toContain(OWN)
      expect(r.body).not.toContain(NAME)
      // and it is escaped: a Host header is attacker input
      const evil = await raw(h.port, 'GET', '/', { host: '<img src=x onerror=alert(1)>' })
      expect(evil.status).toBe(403)
      expect(evil.body).not.toContain('<img src=x')
    } finally { await h.close() }
  })
})

describe('I2 — brackets unwrap only an IPv6 literal', () => {
  it('bracketed non-IPv6 names match nothing', async () => {
    const h = await boot({ allowedHosts: [OWN, NAME] })
    try {
      for (const host of ['[localhost]', '[127.0.0.1]', `[${OWN}]`, `[${NAME}]`, `[localhost]:${h.port}`, `[${OWN}]:${h.port}`, '[]', '[]:1']) {
        const r = await raw(h.port, 'GET', '/', { host })
        expect(r.status, host).toBe(403)
        expect(r.body, host).not.toContain(CANARY)
      }
      // the shape brackets exist for still works
      expect((await raw(h.port, 'GET', '/', { host: `[::1]:${h.port}` })).status).toBe(200)
    } finally { await h.close() }
  })

  it('normaliseHostName leaves a bracketed non-IPv6 value as it is', () => {
    expect(normaliseHostName('[localhost]')).toBe('[localhost]')
    // Left exactly as given, port and all: the value can only ever match an
    // allowlist entry that is the same garbage string, which no browser sends.
    expect(normaliseHostName('[localhost]:7777')).toBe('[localhost]:7777')
    expect(normaliseHostName('[192.168.1.50]:7777')).toBe('[192.168.1.50]:7777')
    expect(normaliseHostName('[::1]:7777')).toBe('::1')
    expect(normaliseHostName('[::FFFF:7F00:1]')).toBe('::ffff:7f00:1')
    // idempotent, still
    for (const v of ['[::1]:7777', '::1', '127.0.0.1:7777', '[localhost]:1', 'a:b:c']) {
      expect(normaliseHostName(normaliseHostName(v)), v).toBe(normaliseHostName(v))
    }
  })
})

describe('I3 — allowlist matching is exact', () => {
  it('near-misses of an allowed IPv4 address are refused', async () => {
    const h = await boot({ allowedHosts: [OWN] })
    try {
      for (const host of [
        `${OWN}.`, `${OWN}.attacker.example`, `attacker.example@${OWN}`, `${OWN}@attacker.example`,
        `0${OWN}`, `${OWN}0`, '192.168.1.5', '192.168.001.050', '3232235826', '0xc0a80132', '0300.0250.01.062',
        `[::ffff:${OWN}]`, '[::ffff:c0a8:132]', `${OWN}%20`, `${OWN}:${h.port}:x`, `${OWN}:x`, `x:${OWN}`,
        `${OWN}/`, `//${OWN}`,
      ]) {
        const r = await raw(h.port, 'GET', '/', { host })
        expect(r.status, JSON.stringify(host)).toBe(403)
        expect(r.body, host).not.toContain(CANARY)
      }
      for (const host of [OWN, `${OWN}:${h.port}`, `${OWN}:80`]) {
        expect((await raw(h.port, 'GET', '/', { host })).status, host).toBe(200)
      }
    } finally { await h.close() }
  })

  it('near-misses of an allowed hostname are refused; case and port are not near-misses', async () => {
    const h = await boot({ allowedHosts: [NAME] })
    try {
      for (const host of [
        `${NAME}.`, `x${NAME}`, `${NAME}.evil.com`, `evil.${NAME}`, `${NAME}:evil`, `${NAME}@evil.com`,
        `${NAME}:${h.port}:1`, `[${NAME}]`, 'my-laptop.loca', 'my-laptop.local1', 'my_laptop.local',
      ]) {
        const r = await raw(h.port, 'GET', '/', { host })
        expect(r.status, host).toBe(403)
      }
      for (const host of [NAME, `MY-LAPTOP.LOCAL:${h.port}`, `${NAME}:${h.port}`]) {
        expect((await raw(h.port, 'GET', '/', { host })).status, host).toBe(200)
      }
    } finally { await h.close() }
  })

  it('an allowed IPv6 address matches its browser spelling and nothing else', async () => {
    const h = await boot({ allowedHosts: ['2001:db8::1'] })
    try {
      expect((await raw(h.port, 'GET', '/', { host: `[2001:db8::1]:${h.port}` })).status).toBe(200)
      expect((await raw(h.port, 'GET', '/', { host: `[2001:DB8::1]:${h.port}` })).status).toBe(200)
      // The bare form is the same address in the same spelling; only a
      // hand-built request can send it, and it is ours. Not a near-miss.
      expect((await raw(h.port, 'GET', '/', { host: '2001:db8::1' })).status).toBe(200)
      for (const host of [`[2001:0db8::1]:${h.port}`, `[2001:db8::1:0]:${h.port}`, `[2001:db8::]:${h.port}`, `[2001:db8::1%25en0]:${h.port}`]) {
        expect((await raw(h.port, 'GET', '/', { host })).status, host).toBe(403)
      }
    } finally { await h.close() }
  })

  it('allowlist entries are normalised the same way the header is', async () => {
    const h = await boot({ allowedHosts: ['[2001:DB8::1]:9999', 'My-Laptop.LOCAL:1', ` ${OWN} `] })
    try {
      expect((await raw(h.port, 'GET', '/', { host: `[2001:db8::1]:${h.port}` })).status).toBe(200)
      expect((await raw(h.port, 'GET', '/', { host: `my-laptop.local:${h.port}` })).status).toBe(200)
      expect((await raw(h.port, 'GET', '/', { host: `${OWN}:${h.port}` })).status).toBe(200)
    } finally { await h.close() }
    // An entry that is a bracketed non-IPv6 name does not unwrap: it allows
    // the name inside it NOT AT ALL, and the literal bracketed string only —
    // a shape no browser can send, since the URL parser refuses it.
    const g = await boot({ allowedHosts: ['[localhost.]'] })
    try {
      expect((await raw(g.port, 'GET', '/', { host: 'localhost.' })).status).toBe(403)
      expect((await raw(g.port, 'GET', '/', { host: `localhost.:${g.port}` })).status).toBe(403)
      expect((await raw(g.port, 'GET', '/', { host: '[localhost.]' })).status).toBe(200)
    } finally { await g.close() }
  })
})

describe('I4 — openPath and a network name cannot be combined', () => {
  const load = async () => ROWS
  it('throws at construction for any non-loopback allowlist entry', () => {
    for (const allowedHosts of [[OWN], [NAME], ['localhost.', OWN], ['0.0.0.0'], ['::'], [''], ['2001:db8::1'], ['::ffff:192.168.1.50'], ['localhost.evil.com'], ['sub.localhost']]) {
      expect(() => createUiServer({ load, where: '', openPath: '/tmp/store', allowedHosts }), JSON.stringify(allowedHosts)).toThrow(/openPath/)
    }
  })
  it('does not throw for loopback-only entries, or without openPath', () => {
    for (const allowedHosts of [[], ['localhost.'], ['127.0.0.2'], ['::ffff:127.0.0.1'], ['0:0:0:0:0:0:0:1'], ['127.1'], ['LOCALHOST']]) {
      expect(() => createUiServer({ load, where: '', openPath: '/tmp/store', allowedHosts }), JSON.stringify(allowedHosts)).not.toThrow()
    }
    expect(() => createUiServer({ load, where: '', allowedHosts: [OWN, NAME] })).not.toThrow()
  })
  it('a widened server without openPath neither renders the button nor serves the route', async () => {
    const h = await boot({ allowedHosts: [OWN] })
    try {
      const page = await raw(h.port, 'GET', '/', { host: `${OWN}:${h.port}` })
      expect(page.status).toBe(200)
      expect(page.body).not.toContain('/open-store')
      expect((await raw(h.port, 'POST', '/open-store', { host: `${OWN}:${h.port}` })).status).toBe(405)
      expect((await raw(h.port, 'POST', '/open-store', { host: `localhost:${h.port}` })).status).toBe(405)
    } finally { await h.close() }
  })
})

describe('I5 — the folder opens only for a peer on this machine', () => {
  const lan = Object.values(networkInterfaces()).flat()
    .find(a => a && !a.internal && a.family === 'IPv4')?.address

  it.skipIf(!lan)('a LAN peer sending an allowed Host and no Origin is refused; a local one is not', async () => {
    // Bound to every interface, with the folder route on — the shape a
    // consumer of the public API could produce without allowedHosts. #939's
    // `curl -H 'Host: localhost'` from the LAN passed the host gate and, with
    // no Origin, the same-origin check too. The socket knows better.
    const h = await boot({ bind: '0.0.0.0', openPath: '/tmp/store' })
    try {
      const cases: Record<string, string>[] = [
        { host: `localhost:${h.port}` },
        { host: `127.0.0.1:${h.port}`, 'sec-fetch-site': 'same-origin' },
        { host: `localhost:${h.port}`, origin: `http://localhost:${h.port}` },
        { host: `[::1]:${h.port}`, 'sec-fetch-site': 'none' },
      ]
      for (const headers of cases) {
        const r = await raw(h.port, 'POST', '/open-store', headers, lan)
        expect(r.status, JSON.stringify(headers)).toBe(403)
        expect(r.body).toContain('from this machine')
      }
      // Control: the identical request from loopback is the legitimate one.
      expect((await raw(h.port, 'POST', '/open-store', { host: `localhost:${h.port}` })).status).toBe(303)
      // And the LAN peer can still READ, which is what widening is for.
      expect((await raw(h.port, 'GET', '/', { host: `localhost:${h.port}` }, lan)).status).toBe(200)
    } finally { await h.close() }
  })
})

describe('I6 — isLoopbackName', () => {
  it('every spelling of loopback', () => {
    for (const v of [
      '127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.255', '127.1', '127.0.1', '2130706433', '0x7f000001', '0177.0.0.1', '0x7f.1',
      'localhost', 'LOCALHOST', 'localhost.', 'LocalHost.',
      '::1', '[::1]', '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]', '::0:1', '0::1',
      '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:127.255.0.3',
      ' 127.0.0.1 ',
    ]) {
      expect(isLoopbackName(v), JSON.stringify(v)).toBe(true)
    }
  })
  it('every spelling of anything else — fail closed', () => {
    for (const v of [
      '', ' ', '0.0.0.0', '0', '::', '[::]', '0:0:0:0:0:0:0:0', '::0', '::ffff:0.0.0.0',
      '192.168.1.50', '10.0.0.4', '128.0.0.1', '126.255.255.255', '1.2.3.127', '::ffff:192.168.1.50', '::ffff:c0a8:132', '::2', '::1:0', '1::1', '2001:db8::1',
      'my-laptop.local', 'sub.localhost', 'localhost.evil.com', 'evil.com', 'localhost..', '.localhost', 'localhos', 'localhost1', 'localhost-',
      'localhost:80', 'localhost:7777', '127.0.0.1:7777', '[::1]:7777', '127.0.0.1/x', 'http://localhost', 'user@localhost', 'localhost#', 'localhost?', '%6cocalhost',
      'fe80::1%en0', '::1%lo0', '127.999.999.999', '127.0.0.1.1', '[localhost]', '[127.0.0.1]', 'local host',
    ]) {
      expect(isLoopbackName(v), JSON.stringify(v)).toBe(false)
    }
  })
  it('isUnspecifiedName covers every spelling, and nothing that is not', () => {
    for (const v of ['0.0.0.0', '0', '0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '::0', '0::', '::ffff:0.0.0.0', '::ffff:0:0', '', '  ']) {
      expect(isUnspecifiedName(v), JSON.stringify(v)).toBe(true)
    }
    for (const v of ['127.0.0.1', 'localhost', '::1', '0.0.0.1', '::ffff:0.0.0.1', '192.168.1.50', 'zero', '0.0.0.0/x', '[0.0.0.0]']) {
      expect(isUnspecifiedName(v), JSON.stringify(v)).toBe(false)
    }
  })
})

describe('I7 — canonicalHostName', () => {
  it('folds to what a browser sends', () => {
    const table: Record<string, string> = {
      'LOCALHOST': 'localhost', 'localhost.': 'localhost.', ' localhost ': 'localhost',
      '127.1': '127.0.0.1', '2130706433': '127.0.0.1', '0x7f000001': '127.0.0.1', '0177.0.0.1': '127.0.0.1', '127.0.0.1.': '127.0.0.1', '1.2.3': '1.2.0.3', '0': '0.0.0.0',
      '::1': '::1', '[::1]': '::1', '0:0:0:0:0:0:0:1': '::1', '[0:0:0:0:0:0:0:1]': '::1', '::': '::', '[::]': '::', '::0': '::',
      '::ffff:127.0.0.1': '::ffff:7f00:1', '::FFFF:127.0.0.1': '::ffff:7f00:1', '::ffff:0.0.0.0': '::ffff:0:0', '::ffff:192.168.1.50': '::ffff:c0a8:132',
      '2001:DB8:0:0:0:0:0:1': '2001:db8::1', 'My-Laptop.LOCAL': 'my-laptop.local', 'Bücher.example': 'xn--bcher-kva.example', 'my_host': 'my_host',
    }
    for (const [input, want] of Object.entries(table)) expect(canonicalHostName(input), JSON.stringify(input)).toBe(want)
  })
  it('refuses anything that is not a bare hostname or IP literal', () => {
    for (const v of [
      '', ' ', 'localhost:80', 'localhost:', '[::1]:80', '[::1]x', '[localhost]', '[127.0.0.1]', '[]', '[',
      'http://localhost', 'localhost/', 'localhost/x', 'localhost?x', 'localhost#x', 'user@localhost', 'user:pw@localhost',
      'a b', 'local host', '%41', '%6cocalhost', 'fe80::1%en0', '::1%lo0', '127.999.999.999', '1.2.3.4.5', '256.1.1.1',
      'ex ample', 'a\\b', 'a[b', 'a]b',
    ]) {
      expect(canonicalHostName(v), JSON.stringify(v)).toBeUndefined()
    }
  })
})
