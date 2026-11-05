// `latest` comes from the user's own npm: its registry, a scoped mirror set in
// .npmrc or npm_config_* variables, and the token for that registry. A registry
// that cannot be reached is named (host:port only) and never answered from npm's
// cache. Runs the real npm against a local mirror; no request leaves 127.0.0.1.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { npmLatest, resolveNpmCli, classifyNpmError, registryHost } from '../src/npm-latest.js'
import { startMirror, refusedPort, npmSandbox, type Mirror, type NpmSandbox } from './npm-mirror.js'

const PKG = '@plur-ai/mcp'

describe('npmLatest reads latest through the npm configuration', () => {
  const realFetch = globalThis.fetch
  const fetched: string[] = []
  let mirror: Mirror
  let box: NpmSandbox | undefined

  beforeEach(async () => {
    fetched.length = 0
    // Any direct registry read from this process is a failure of the rule.
    globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); throw new TypeError('fetch blocked in test') }) as typeof fetch
    mirror = await startMirror({ [PKG]: '9.8.7', '@plur-ai/cli': '9.8.7' })
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    await mirror.close()
    box?.cleanup(); box = undefined
  })

  it('default registry from .npmrc', async () => {
    box = npmSandbox(`registry=${mirror.url}\n`)
    expect(await npmLatest(PKG, { env: box.env })).toEqual({ state: 'ok', version: '9.8.7' })
    expect(mirror.requests).toContain(`/${PKG}`)
    expect(fetched).toEqual([])
  })

  it('scoped @plur-ai:registry mirror in .npmrc wins over the default registry', async () => {
    const dead = await refusedPort()
    box = npmSandbox(`registry=http://127.0.0.1:${dead}/\n@plur-ai:registry=${mirror.url}\n`)
    expect(await npmLatest(PKG, { env: box.env })).toEqual({ state: 'ok', version: '9.8.7' })
  })

  it('scoped mirror through an npm_config_* variable', async () => {
    const dead = await refusedPort()
    box = npmSandbox(`registry=http://127.0.0.1:${dead}/\n`, { 'npm_config_@plur-ai:registry': mirror.url })
    expect(await npmLatest(PKG, { env: box.env })).toEqual({ state: 'ok', version: '9.8.7' })
  })

  it('sends the token configured for that registry', async () => {
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n//${mirror.host}/:_authToken=t0ken-1833\n`)
    expect((await npmLatest(PKG, { env: box.env })).state).toBe('ok')
    expect(mirror.auth).toContain('Bearer t0ken-1833')
  })

  it('refused connection: unreachable, names host:port, a connect failure', async () => {
    const dead = await refusedPort()
    box = npmSandbox(`@plur-ai:registry=http://127.0.0.1:${dead}/\n`)
    expect(await npmLatest(PKG, { env: box.env })).toEqual({
      state: 'unreachable', registry: `127.0.0.1:${dead}`, reason: 'connection refused', connectFailure: true,
    })
  })

  it('HTTP 500: unreachable, reachable host (not a connect failure), no retry', async () => {
    mirror.setMode('500')
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n`)
    const t0 = Date.now()
    expect(await npmLatest(PKG, { env: box.env })).toEqual({
      state: 'unreachable', registry: mirror.host, reason: 'it answered HTTP 500', connectFailure: false,
    })
    expect(mirror.requests).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('timeout: unreachable within the bound', async () => {
    mirror.setMode('hang')
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n`)
    const t0 = Date.now()
    expect(await npmLatest(PKG, { env: box.env, timeoutMs: 500 })).toEqual({
      state: 'unreachable', registry: mirror.host, reason: 'timed out', connectFailure: true,
    })
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('a package the registry does not have: missing', async () => {
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n`)
    expect(await npmLatest('@plur-ai/opencode', { env: box.env })).toEqual({
      state: 'missing', registry: mirror.host, reason: 'it has no @plur-ai/opencode',
    })
  })

  it('never answers from npm\'s cache once the registry is gone', async () => {
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n`)
    expect(await npmLatest(PKG, { env: box.env })).toEqual({ state: 'ok', version: '9.8.7' })
    await mirror.close()
    const r = await npmLatest(PKG, { env: box.env })
    expect(r.state).toBe('unreachable')
    mirror = await startMirror({})
  })

  it('credentials in a registry URL are never printed', async () => {
    const dead = await refusedPort()
    box = npmSandbox(`@plur-ai:registry=http://user:s3cret@127.0.0.1:${dead}/\n`)
    const r = await npmLatest(PKG, { env: box.env })
    expect(r.state).toBe('unreachable')
    expect(JSON.stringify(r)).not.toContain('s3cret')
    expect(registryHost('request to https://u:p@reg.example:8443/x failed')).toBe('reg.example:8443')
  })

  it('no npm: says so, makes no request', async () => {
    expect(await npmLatest(PKG, { npmCli: null })).toEqual({
      state: 'no-npm', registry: 'the configured npm registry', reason: 'npm was not found beside this Node',
    })
    expect(mirror.requests).toEqual([])
    expect(fetched).toEqual([])
  })
})

describe('classifyNpmError', () => {
  it.each([
    ['ENOTFOUND', 'request to https://reg.example/x failed, reason: getaddrinfo ENOTFOUND reg.example', 'host not found', true],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'request to https://reg.example/x failed, reason: self-signed certificate', 'TLS certificate not trusted, check cafile / strict-ssl', true],
    ['E401', '401 Unauthorized - GET https://reg.example/x', 'it answered HTTP 401: not authorised, check the token for that registry', false],
    ['EWHATEVER', 'something https://reg.example/x', 'npm error EWHATEVER', false],
  ])('%s', (code, summary, reason, connectFailure) => {
    expect(classifyNpmError('@plur-ai/mcp', code, summary)).toEqual({ state: 'unreachable', registry: 'reg.example', reason, connectFailure })
  })
})

describe('resolveNpmCli', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-npmcli-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const script = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'npm-cli.js')
    writeFileSync(f, '')
    return f
  }

  it('prefers the npm that started the process', () => {
    const f = script(join(root, 'started'))
    expect(resolveNpmCli({ npm_execpath: f, PATH: '' }, 'linux', join(root, 'bin', 'node'))).toBe(f)
  })

  it('then the npm beside Node', () => {
    const f = script(join(root, 'lib', 'node_modules', 'npm', 'bin'))
    expect(resolveNpmCli({ PATH: '' }, 'linux', join(root, 'bin', 'node'))).toBe(f)
  })

  it('then the npm link beside Node (Homebrew layout)', () => {
    const f = script(join(root, 'elsewhere', 'npm', 'bin'))
    mkdirSync(join(root, 'cellar', 'bin'), { recursive: true })
    symlinkSync(f, join(root, 'cellar', 'bin', 'npm'))
    expect(resolveNpmCli({ PATH: '' }, 'linux', join(root, 'cellar', 'bin', 'node'))).toMatch(/elsewhere\/npm\/bin\/npm-cli\.js$/)
  })

  it('then npm on PATH, and null when there is none', () => {
    const f = script(join(root, 'pathnpm', 'bin'))
    mkdirSync(join(root, 'p'), { recursive: true })
    symlinkSync(f, join(root, 'p', 'npm'))
    expect(resolveNpmCli({ PATH: join(root, 'p') }, 'linux', join(root, 'x', 'node'))).toMatch(/pathnpm\/bin\/npm-cli\.js$/)
    expect(resolveNpmCli({ PATH: '' }, 'linux', join(root, 'x', 'node'))).toBeNull()
  })
})
