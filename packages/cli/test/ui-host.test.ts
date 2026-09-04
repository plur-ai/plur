/**
 * Adversarial tests for `plur ui --host` / `--allow-host`.
 *
 * INVARIANTS UNDER TEST — each `describe` below tries to break one.
 *
 *  C1  Every value `--host` accepts produces a printed URL that `new URL()`
 *      parses, and whose host the server it configures answers with 200 — for
 *      every loopback spelling, every unspecified spelling, an address and a
 *      name. (Finding B2: the operator can always open the viewer they started.)
 *  C2  Under that same configuration a rebound request — the attacker's domain
 *      in Host, browser fetch-metadata present — is 403 with no store content.
 *  C3  `--host` and `--allow-host` refuse anything but a bare hostname or IP
 *      literal — scheme, path, port, credentials, whitespace, zone id, empty,
 *      brackets around a non-IPv6 value — and the error names the mistake.
 *  C4  The folder-reveal route is granted only for a loopback bind with no
 *      non-loopback `--allow-host`; a widened bind never gets it; and what the
 *      CLI decides is what the server accepts (the two gates agree).
 *  C5  The unspecified address never appears in the allowlist; interface
 *      addresses do, canonicalised, and only for an unspecified bind; the
 *      literal `--host` value always does for a specific bind.
 *  C6  `--allow-host` entries are added verbatim (canonical) and nothing else
 *      is derived from them.
 */
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { createUiServer, parseHostValue, parseUiArgs, planViewer, urlHostFor } from '../src/commands/ui-server.js'

const CANARY = 'CANARY-STATEMENT-1b9e'
const ROWS = [
  { id: 'ENG-2026-0814-001', statement: CANARY, scope: 'project:acme', status: 'active', activation: { frequency: 4 } },
]
const IFACES = () => ['192.168.1.50', 'FE80::1', '10.0.0.4', 'fd7a:115c:a1e0::1', 'FE80::ACE:1%en0', '0.0.0.0', '::']

function rawGet(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers }, res => {
      let body = ''
      res.on('data', c => { body += String(c) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Exactly what `run()` hands to createUiServer, minus the store. */
async function bootFromFlags(args: string[]) {
  const opts = parseUiArgs(args)
  const plan = planViewer(opts, { interfaces: IFACES })
  const server = createUiServer({
    load: async () => ROWS,
    where: '~/.plur',
    ...(plan.revealFolder ? { openPath: '/tmp/store' } : {}),
    allowedHosts: plan.allowedHosts,
  })
  // Always a loopback socket here: the test is about the URL and the policy,
  // not about binding the machine's real interfaces.
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { opts, plan, port, url: `http://${plan.urlHost}:${port}/`, close: () => new Promise<void>(r => server.close(() => r())) }
}

const ACCEPTED_HOSTS = [
  '127.0.0.1', 'localhost', 'LOCALHOST', 'localhost.', '127.0.0.2', '127.1', '2130706433', '0x7f000001', '0177.0.0.1',
  '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '[::ffff:127.0.0.1]',
  '0.0.0.0', '0', '::', '[::]', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0',
  '192.168.1.50', '::ffff:192.168.1.50', '2001:db8::1', 'My-Laptop.LOCAL', 'localhost.evil.com', 'Bücher.example',
]

describe('C1 — the printed URL is one the server answers', () => {
  it('for every accepted --host spelling', async () => {
    for (const host of ACCEPTED_HOSTS) {
      const h = await bootFromFlags(['--host', host])
      try {
        let parsed: URL | undefined
        expect(() => { parsed = new URL(h.url) }, `${host} → ${h.url}`).not.toThrow()
        const r = await rawGet(h.port, { host: parsed!.host })
        expect(r.status, `${host} → ${h.url} → Host: ${parsed!.host}`).toBe(200)
        expect(r.body, host).toContain(CANARY)
      } finally { await h.close() }
    }
  })

  it('IPv6 is bracketed and the unspecified address becomes its family loopback', () => {
    expect(urlHostFor('::1')).toBe('[::1]')
    expect(urlHostFor('[::1]')).toBe('[::1]')
    expect(urlHostFor('0:0:0:0:0:0:0:1')).toBe('[::1]')
    expect(urlHostFor('::ffff:127.0.0.1')).toBe('[::ffff:7f00:1]')
    expect(urlHostFor('2001:DB8::1')).toBe('[2001:db8::1]')
    expect(urlHostFor('::')).toBe('[::1]')
    expect(urlHostFor('[::]')).toBe('[::1]')
    expect(urlHostFor('0:0:0:0:0:0:0:0')).toBe('[::1]')
    expect(urlHostFor('0.0.0.0')).toBe('127.0.0.1')
    expect(urlHostFor('0')).toBe('127.0.0.1')
    expect(urlHostFor('::ffff:0.0.0.0')).toBe('127.0.0.1')
    expect(urlHostFor('localhost.')).toBe('localhost.')
    expect(urlHostFor('127.1')).toBe('127.0.0.1')
    expect(urlHostFor('My-Laptop.LOCAL')).toBe('my-laptop.local')
    for (const v of ['::1', '::', '0.0.0.0', 'localhost.', '2001:db8::1', '::ffff:127.0.0.1']) {
      expect(() => new URL(`http://${urlHostFor(v)}:7777/`), v).not.toThrow()
    }
  })
})

describe('C2 — a rebound request is still refused under every accepted --host', () => {
  it('attacker domain in Host, with the fetch-metadata a rebound browser sends', async () => {
    for (const host of ACCEPTED_HOSTS) {
      const h = await bootFromFlags(['--host', host, '--allow-host', 'my-laptop.local'])
      try {
        for (const attacker of ['attacker.example', 'localhost.attacker.example', `${h.plan.urlHost.replace(/^\[|\]$/g, '')}.attacker.example`, '192.168.1.51', '[2001:db8::2]']) {
          for (const site of ['none', 'same-origin']) {
            const r = await rawGet(h.port, { host: `${attacker}:${h.port}`, 'sec-fetch-site': site })
            expect(r.status, `--host ${host}; Host: ${attacker}; sec-fetch-site: ${site}`).toBe(403)
            expect(r.body, host).not.toContain(CANARY)
          }
        }
      } finally { await h.close() }
    }
  })
})

describe('C3 — host flags accept only a bare hostname or IP literal', () => {
  const bad: Array<[string | undefined, RegExp]> = [
    [undefined, /needs a value/], ['', /needs a value/], ['  ', /needs a value/],
    ['http://localhost', /bare hostname/], ['localhost/', /bare hostname/], ['localhost/x', /bare hostname/], ['localhost?x', /bare hostname/],
    ['localhost#x', /bare hostname/], ['user@localhost', /bare hostname/], ['a b', /bare hostname/], ['%41', /bare hostname/], ['a\\b', /bare hostname/],
    ['localhost:80', /takes no port/], ['localhost:', /takes no port/], ['127.0.0.1:7777', /takes no port/], ['host:abc', /takes no port/],
    ['[::1]:80', /takes no port/], ['[::1]x', /takes no port/], ['[::1]:', /takes no port/],
    ['[localhost]', /brackets enclose only an IPv6/], ['[127.0.0.1]', /brackets enclose only an IPv6/], ['[]', /brackets enclose only an IPv6/],
    ['fe80::1%en0', /zone id/], ['::1%lo0', /zone id/], ['[fe80::1%en0]', /zone id/],
    ['127.999.999.999', /not a valid/], ['256.1.1.1', /not a valid/], ['1.2.3.4.5', /not a valid/], ['a[b', /not a valid/],
  ]
  it('--host', () => {
    for (const [v, want] of bad) {
      expect(() => parseUiArgs(v === undefined ? ['--host'] : ['--host', v]), JSON.stringify(v)).toThrow(want)
      expect(() => parseHostValue(v, '--host'), JSON.stringify(v)).toThrow(want)
    }
  })
  it('--allow-host, identically', () => {
    for (const [v, want] of bad) {
      expect(() => parseUiArgs(['--host', '0.0.0.0', ...(v === undefined ? ['--allow-host'] : ['--allow-host', v])]), JSON.stringify(v)).toThrow(want)
    }
  })
  it('the error names the flag', () => {
    expect(() => parseUiArgs(['--allow-host', 'localhost:80'])).toThrow(/--allow-host/)
    expect(() => parseUiArgs(['--host', 'localhost:80'])).toThrow(/--host/)
  })
  it('accepted values are stored canonical, without brackets', () => {
    expect(parseUiArgs(['--host', 'LOCALHOST']).host).toBe('localhost')
    expect(parseUiArgs(['--host', '[::1]']).host).toBe('::1')
    expect(parseUiArgs(['--host', '0:0:0:0:0:0:0:1']).host).toBe('::1')
    expect(parseUiArgs(['--host', '127.1']).host).toBe('127.0.0.1')
    expect(parseUiArgs(['--host', ' localhost. ']).host).toBe('localhost.')
    expect(parseUiArgs(['--host', '::FFFF:127.0.0.1']).host).toBe('::ffff:7f00:1')
    expect(parseUiArgs(['--host', 'Bücher.example']).host).toBe('xn--bcher-kva.example')
    expect(parseUiArgs([]).host).toBe('127.0.0.1')
    expect(parseUiArgs([]).allowHosts).toEqual([])
  })
})

describe('C4 — the folder-reveal route', () => {
  it('is granted only for a loopback bind with loopback-only extras', () => {
    const grant = (args: string[]) => planViewer(parseUiArgs(args), { interfaces: IFACES })
    for (const args of [[], ['--host', 'localhost'], ['--host', 'localhost.'], ['--host', '::1'], ['--host', '127.0.0.2'], ['--host', '0x7f000001'],
      ['--host', '::ffff:127.0.0.1'], ['--host', 'localhost', '--allow-host', '127.0.0.2', '--allow-host', 'localhost.']]) {
      const p = grant(args)
      expect(p.revealFolder, args.join(' ')).toBe(true)
      expect(p.widened, args.join(' ')).toBe(false)
    }
    for (const args of [['--host', '0.0.0.0'], ['--host', '0'], ['--host', '::'], ['--host', '::ffff:0.0.0.0'], ['--host', '192.168.1.50'],
      ['--host', 'my-laptop.local'], ['--host', 'localhost.evil.com'], ['--host', 'sub.localhost'], ['--host', '::ffff:192.168.1.50']]) {
      const p = grant(args)
      expect(p.revealFolder, args.join(' ')).toBe(false)
      expect(p.widened, args.join(' ')).toBe(true)
    }
    // A loopback bind that vouches for a network name is reachable by that
    // name: no folder button, but no network warning either.
    for (const args of [['--host', 'localhost', '--allow-host', 'my-laptop.local'], ['--host', '127.0.0.1', '--allow-host', '192.168.1.50'],
      ['--allow-host', '127.0.0.2', '--allow-host', '0.0.0.0']]) {
      const p = grant(args)
      expect(p.revealFolder, args.join(' ')).toBe(false)
      expect(p.widened, args.join(' ')).toBe(false)
    }
  })

  it("what the CLI decides is what the server accepts — for every plan, and for the plan's inverse", () => {
    const load = async () => ROWS
    for (const host of [...ACCEPTED_HOSTS, 'sub.localhost']) {
      for (const extra of [[], ['--allow-host', 'my-laptop.local'], ['--allow-host', '127.0.0.2']]) {
        const plan = planViewer(parseUiArgs(['--host', host, ...extra]), { interfaces: IFACES })
        const asRun = { load, where: '', ...(plan.revealFolder ? { openPath: '/tmp/store' } : {}), allowedHosts: plan.allowedHosts }
        expect(() => createUiServer(asRun), `${host} ${extra.join(' ')}`).not.toThrow()
        if (!plan.revealFolder) {
          // The server refuses exactly the thing the CLI withheld.
          expect(() => createUiServer({ ...asRun, openPath: '/tmp/store' }), `${host} ${extra.join(' ')} + openPath`).toThrow(/openPath/)
        }
      }
    }
  })

  it('a widened server never renders the button nor serves the route', async () => {
    for (const args of [['--host', '0.0.0.0'], ['--host', '192.168.1.50'], ['--host', 'localhost', '--allow-host', 'my-laptop.local']]) {
      const h = await bootFromFlags(args)
      try {
        const page = await rawGet(h.port, { host: new URL(h.url).host })
        expect(page.status, args.join(' ')).toBe(200)
        expect(page.body, args.join(' ')).not.toContain('/open-store')
      } finally { await h.close() }
    }
  })
})

describe('C5 — what goes on the allowlist', () => {
  const plan = (host: string, allow: string[] = []) => planViewer({ host, allowHosts: allow }, { interfaces: IFACES })

  it('an unspecified bind lists interface addresses, canonical, never the unspecified address', () => {
    for (const host of ['0.0.0.0', '0', '::', '[::]', '0:0:0:0:0:0:0:0', '::0', '::ffff:0.0.0.0', '']) {
      const p = plan(host)
      expect(p.allowedHosts, host).toEqual(['192.168.1.50', '10.0.0.4', 'fd7a:115c:a1e0::1'])
      // never the unspecified address, and never link-local IPv6: a browser
      // cannot send either as Host, so listing them would be noise at best.
      for (const never of ['0.0.0.0', '::', '0', '::ffff:0:0', '', 'fe80::1', 'fe80::ace:1']) expect(p.allowedHosts, `${host} must not list ${never}`).not.toContain(never)
    }
  })

  it('a specific bind lists exactly the literal value, and no interface', () => {
    for (const [host, want] of [['192.168.1.50', '192.168.1.50'], ['localhost.', 'localhost.'], ['LOCALHOST', 'localhost'], ['127.0.0.2', '127.0.0.2'],
      ['127.1', '127.0.0.1'], ['[::1]', '::1'], ['::ffff:127.0.0.1', '::ffff:7f00:1'], ['My-Laptop.LOCAL', 'my-laptop.local'], ['2001:DB8::1', '2001:db8::1']]) {
      const p = plan(host!)
      expect(p.allowedHosts, host).toEqual([want])
      expect(p.bind, host).toBe(want)
    }
  })

  it('the real interface enumerator returns addresses, never loopback, never the unspecified address', () => {
    const p = planViewer({ host: '0.0.0.0', allowHosts: [] })
    for (const a of p.allowedHosts) {
      expect(a, a).not.toMatch(/^127\./)
      expect(a, a).not.toBe('::1')
      expect(a, a).not.toBe('0.0.0.0')
      expect(a, a).not.toBe('::')
      expect(a, a).not.toMatch(/%/)
      expect(a, a).not.toMatch(/^fe[89ab][0-9a-f]:/)
      expect(a, a).not.toMatch(/[A-Z[\]]/)
    }
  })
})

describe('C6 — --allow-host entries', () => {
  it('are added verbatim in canonical form, on any bind, in order, deduplicated', () => {
    const p = planViewer(parseUiArgs(['--host', '0.0.0.0', '--allow-host', 'My-Laptop.LOCAL', '--allow-host', '[2001:DB8::1]', '--allow-host', '192.168.1.50', '--allow-host', 'my-laptop.local']), { interfaces: IFACES })
    expect(p.allowedHosts).toEqual(['192.168.1.50', '10.0.0.4', 'fd7a:115c:a1e0::1', 'my-laptop.local', '2001:db8::1'])
    const q = planViewer(parseUiArgs(['--allow-host', 'proxy.internal']), { interfaces: IFACES })
    expect(q.allowedHosts).toEqual(['127.0.0.1', 'proxy.internal'])
    expect(q.widened).toBe(false)
    expect(q.revealFolder).toBe(false)
  })
  it('vouching for a name allows exactly that name', async () => {
    const h = await bootFromFlags(['--host', '0.0.0.0', '--allow-host', 'my-laptop.local'])
    try {
      expect((await rawGet(h.port, { host: `my-laptop.local:${h.port}` })).status).toBe(200)
      expect((await rawGet(h.port, { host: `MY-LAPTOP.LOCAL:${h.port}` })).status).toBe(200)
      for (const host of ['my-laptop.local.', 'my-laptop.local.attacker.example', 'evil.my-laptop.local', 'my-laptop.locale', 'attacker.example']) {
        expect((await rawGet(h.port, { host: `${host}:${h.port}`, 'sec-fetch-site': 'none' })).status, host).toBe(403)
      }
    } finally { await h.close() }
  })
})
