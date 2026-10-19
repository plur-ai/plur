/**
 * Codex round 4, finding 3: a configured server url can carry credentials
 * (`https://user:password@host`). Requests go to the sanitized endpoint, but
 * log lines and messages used to interpolate the configured url verbatim.
 *
 * Every log line is captured (PLUR_LOG_LEVEL=debug, so nothing is suppressed
 * and the "not contained" assertions are not vacuous) and grepped for the
 * planted credential. Real HTTP against the stub.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { RemoteStore } from '../src/store/remote-store.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'plur_sk_c4-log-token'
const USER = 'logleakuser'
const PASSWORD = 'FAKE_PW_4471'
const PERSONAL = 'user:acme:alice'
const TEAM = 'group:acme/team'

let stub: StubServer
let url: string
let credUrl: string
let dir: string
let lines: string[]
let savedLevel: string | undefined

const ME = {
  username: 'alice', org_id: 'acme', role: 'developer',
  scopes: [PERSONAL, TEAM],
  scopes_status: 'ok', scope_metadata_status: 'absent',
  // Fails the host grammar: the /me "do not conform" warning fires.
  gitlab_host: 'not a host!',
}

function leaked(): string[] {
  return lines.filter(l => l.includes(PASSWORD) || l.includes(`${USER}:`))
}

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  ;({ url } = await stub.start())
  credUrl = url.replace('://', `://${USER}:${PASSWORD}@`)
})
afterAll(async () => { await stub.stop() })
beforeEach(() => {
  stub.reset()
  stub.setMe(ME)
  dir = mkdtempSync(join(tmpdir(), 'plur-c4-log-'))
  lines = []
  savedLevel = process.env.PLUR_LOG_LEVEL
  process.env.PLUR_LOG_LEVEL = 'debug'
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '))
  })
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (savedLevel === undefined) delete process.env.PLUR_LOG_LEVEL
  else process.env.PLUR_LOG_LEVEL = savedLevel
  rmSync(dir, { recursive: true, force: true })
})

describe('a credential-bearing server url never reaches a log line', () => {
  it('/me with a malformed gitlab_host: the warning is emitted, without the userinfo', async () => {
    const me = await new RemoteStore(credUrl, TOKEN, PERSONAL).me()
    expect(me.gitlab_host).toBeUndefined()
    const warning = lines.find(l => l.includes('do not conform'))
    expect(warning).toBeDefined()
    expect(warning).toContain(new URL(url).host)
    expect(leaked()).toEqual([])
  })

  it('discovery, refresh and key rotation: no captured line carries the planted credential', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        // The server entry discovery refreshes, with a pinned scope /me does
        // not list (the pinned-scope warning) and a scope that fails the
        // grammar (the expansion warning).
        {
          url: credUrl, token: TOKEN, enterprise: { hello_engram_id: 'ENG-1' },
          scope: PERSONAL, scopes: [PERSONAL, 'bad scope!'], pinned_scopes: ['group:acme/pinned'],
        },
        // An invalid plain entry with no scope: the config loader names it by url.
        { url: credUrl, token: 42 },
      ],
    }))
    const plur = new Plur({ path: dir })
    const outcomes = await plur.refreshServerScopes()
    expect(outcomes).toHaveLength(1)
    // Rotation of the server key, by the configured (credential-bearing) url.
    const rotated = plur.addStore('', PERSONAL, { url: credUrl, token: 'plur_sk_c4-rotated' })
    expect(rotated.status).toBe('token_rotated')
    // A second refresh with the rotated key.
    await new Plur({ path: dir }).refreshServerScopes()

    // Not vacuous: the paths under test did log.
    expect(lines.some(l => l.includes('do not conform'))).toBe(true)
    expect(lines.some(l => l.includes('pinned scope'))).toBe(true)
    expect(lines.some(l => l.includes('rotated the server key'))).toBe(true)
    expect(lines.some(l => l.includes('dropping invalid stores'))).toBe(true)
    expect(leaked()).toEqual([])
    // Nor any returned message. (`outcome.url` is the configured url itself,
    // the entry's key for the caller, not a message.)
    expect(JSON.stringify([outcomes.map(o => o.error ?? null), rotated])).not.toContain(PASSWORD)
  })
})
