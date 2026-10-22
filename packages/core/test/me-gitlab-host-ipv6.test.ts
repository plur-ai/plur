/**
 * `gitlab_host` from GET /api/v1/me accepts a bracketed IPv6 literal.
 *
 * The server reports the host of its GitLab url, so GITLAB_URL
 * https://[2001:db8::1]:8443 arrives as "[2001:db8::1]:8443". The host grammar
 * used to accept only names and IPv4, and dropped that value as invalid. A
 * bracketed literal is accepted only in canonical form (what the URL parser
 * prints), with an optional port, and never with userinfo, a path or junk.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { RemoteStore } from '../src/store/remote-store.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'me-ipv6-test-token'
let stub: StubServer
let store: RemoteStore

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  const { url } = await stub.start()
  store = new RemoteStore(url, TOKEN, '')
})
afterAll(async () => { await stub.stop() })
beforeEach(() => { stub.reset() })

const hostFor = async (gitlab_host: string): Promise<string | null | undefined> => {
  stub.setMe({ username: 'alice', org_id: 'acme', scopes: ['user:acme:alice'], scopes_status: 'ok', gitlab_host })
  return (await store.me()).gitlab_host
}

describe('RemoteStore.me() gitlab_host: bracketed IPv6', () => {
  it('keeps the value the server produces for GITLAB_URL=https://[2001:db8::1]:8443', async () => {
    expect(await hostFor('[2001:db8::1]:8443')).toBe('[2001:db8::1]:8443')
  })

  it('keeps a bracketed literal without a port', async () => {
    expect(await hostFor('[2001:db8::1]')).toBe('[2001:db8::1]')
  })

  it('still keeps a plain host name', async () => {
    expect(await hostFor('gitlab.example.com:8443')).toBe('gitlab.example.com:8443')
  })

  it.each([
    '[2001:db8::1',              // unclosed
    '2001:db8::1',               // unbracketed
    '[not-an-address]',
    '[2001:db8::g]',
    '[2001:DB8::1]',             // not canonical (upper case)
    '[2001:db8:0:0:0:0:0:1]',    // not canonical (uncompressed)
    '[2001:db8::1]:99999',       // port out of range
    '[2001:db8::1]:',            // empty port
    'user@[2001:db8::1]',        // userinfo
    '[2001:db8::1]/group',       // path
    '[2001:db8::1]:8443\nX',     // trailing junk
    '[::ffff:192.0.2.1]x',
  ])('drops %j', async (h) => {
    expect(await hostFor(h)).toBeUndefined()
  })
})
