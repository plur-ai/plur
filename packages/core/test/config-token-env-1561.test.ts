/**
 * #1561 (0.21.1 pre-release integration check, L5): a remote store can name
 * the environment variable that holds its token (`token_env: VAR`) instead of
 * carrying the token. The token is read from the variable when config.yaml is
 * loaded, and every write-back of the stores list keeps the reference and
 * never the value — the stores list is rewritten from the loaded (resolved)
 * entries, so without that rule the first write-back would store the secret.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { loadConfig } from '../src/config.js'
import { StubServer } from './helpers/stub-server.js'

const VAR = 'PLUR_TEST_TOKEN_ENV_1561'
const SECRET = 'plr_token-env-SECRET-1561'

describe('token_env on a remote store (#1561)', () => {
  let dir: string
  let saved: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-token-env-'))
    saved = process.env[VAR]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[VAR]
    else process.env[VAR] = saved
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (stores: unknown[]) =>
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ embeddings: { enabled: false }, stores }))

  it('resolves the token from the named variable at load', () => {
    process.env[VAR] = `${SECRET}\n`
    write([{ url: 'https://plur.example.com', token_env: VAR, scope: 'group:a/b', shared: true }])
    const store = loadConfig(join(dir, 'config.yaml')).stores![0]
    expect(store.token).toBe(SECRET)
    expect(store.token_env).toBe(VAR)
  })

  it('an unset or empty variable leaves the store without a token', () => {
    delete process.env[VAR]
    write([{ url: 'https://plur.example.com', token_env: VAR, scope: 'group:a/b' }])
    expect(loadConfig(join(dir, 'config.yaml')).stores![0].token).toBeUndefined()
    process.env[VAR] = '   '
    expect(loadConfig(join(dir, 'config.yaml')).stores![0].token).toBeUndefined()
  })

  it('a token written in the file is used as written', () => {
    process.env[VAR] = SECRET
    write([{ url: 'https://plur.example.com', token: 'literal', token_env: VAR, scope: 'group:a/b' }])
    expect(loadConfig(join(dir, 'config.yaml')).stores![0].token).toBe('literal')
  })

  it('a write-back of the stores list keeps the reference and never stores the value', () => {
    process.env[VAR] = SECRET
    write([{ url: 'https://plur.example.com', token_env: VAR, scope: 'group:a/b', shared: true }])
    const plur = new Plur({ path: dir })
    // Appending a local store rewrites every entry of the list from the loaded config.
    plur.addStore(join(dir, 'extra.yaml'), 'project:extra')
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(text).not.toContain(SECRET)
    const stores = (yaml.load(text) as { stores: Array<Record<string, unknown>> }).stores
    expect(stores[0]).toMatchObject({ url: 'https://plur.example.com', token_env: VAR, scope: 'group:a/b' })
    expect(stores[0]).not.toHaveProperty('token')
    expect(stores.map(s => s.scope)).toEqual(['group:a/b', 'project:extra'])
  })

  it('addStore with tokenEnv writes the reference, not the token', () => {
    process.env[VAR] = SECRET
    write([])
    const plur = new Plur({ path: dir })
    expect(plur.addStore('', 'group:a/b', { url: 'https://plur.example.com', token: SECRET, tokenEnv: VAR }).status).toBe('added')
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).toContain(`token_env: ${VAR}`)
    // Same variable again: nothing to change.
    expect(plur.addStore('', 'group:a/b', { url: 'https://plur.example.com', token: SECRET, tokenEnv: VAR }).status).toBe('already_registered')
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(text)
    // A literal token given later replaces the reference (the caller chose to store it).
    expect(plur.addStore('', 'group:a/b', { url: 'https://plur.example.com', token: 'other-literal' }).status).toBe('token_rotated')
    const after = (yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores: Array<Record<string, unknown>> }).stores[0]
    expect(after.token).toBe('other-literal')
    expect(after).not.toHaveProperty('token_env')
  })
})

describe('scopes registered from a token_env store keep the reference (#1561)', () => {
  let server: StubServer
  let baseUrl: string
  let dir: string
  let saved: string | undefined

  beforeAll(async () => {
    server = new StubServer(SECRET)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => { await server.stop() })
  beforeEach(() => {
    server.reset()
    server.setMe({ username: 'm', org_id: 'o', role: 'developer', scopes: ['group:o/eng', 'group:o/ops'] })
    dir = mkdtempSync(join(tmpdir(), 'plur-token-env-disc-'))
    saved = process.env[VAR]
    process.env[VAR] = SECRET
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[VAR]
    else process.env[VAR] = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('registerDiscoveredScopes and registerScope write token_env, never the value', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token_env: VAR, scope: 'group:o/eng', shared: true }],
    }))
    const plur = new Plur({ path: dir })
    const [result] = await plur.registerDiscoveredScopes()
    expect(result.ok).toBe(true)
    expect(result.added).toEqual(['group:o/ops'])
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(text).not.toContain(SECRET)
    const stores = (yaml.load(text) as { stores: Array<Record<string, unknown>> }).stores
    expect(stores.map(s => s.token_env)).toEqual([VAR, VAR])
    expect(stores.every(s => !('token' in s))).toBe(true)
  })
})

// #1564 review M2: a token_env store whose variable is unset must not send an
// unauthenticated request, and every reason the user sees names the variable
// to set — never "put the token in config.yaml".
describe('a token_env store with the variable unset (#1564 review M2)', () => {
  let server: StubServer
  let baseUrl: string
  let dir: string
  let saved: string | undefined

  beforeAll(async () => {
    server = new StubServer(SECRET)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => { await server.stop() })
  beforeEach(() => {
    server.reset()
    server.setMe({ username: 'm', org_id: 'o', role: 'developer', scopes: ['group:o/eng'] })
    dir = mkdtempSync(join(tmpdir(), 'plur-token-env-unset-'))
    saved = process.env[VAR]
    delete process.env[VAR]
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token_env: VAR, scope: 'group:o/eng', shared: true, dial: 'always' }],
    }))
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[VAR]
    else process.env[VAR] = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('a team save sends nothing and queues with a reason that names the variable', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('deploys go through the blue lane', { scope: 'group:o/eng' })
    expect(server.appendCalls).toBe(0)
    const d = plur.deliveryOf(e, 'group:o/eng')
    expect(d.delivery).toBe('outbox')
    expect(d.reason_code).toBe('token_env_unset')
    expect(d.reason).toContain(VAR)
    expect(d.reason).not.toMatch(/config\.yaml/)
  })

  it('the remote health check sends no /me and names the variable', async () => {
    const plur = new Plur({ path: dir })
    const [h] = await plur.checkRemoteHealth()
    expect(server.meCalls).toBe(0)
    expect(h.ok).toBe(false)
    expect(h.tokenEnvUnset).toBe(VAR)
    expect(h.reason).toContain(VAR)
  })

  it('remote recall does not dial that host', () => {
    const plur = new Plur({ path: dir })
    expect((plur as any)._remoteRecallHosts({ scope: 'group:o/eng' })).toEqual([])
  })
})
