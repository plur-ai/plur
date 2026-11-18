// `plur doctor` asks whether @plur-ai/opencode is published on the registry npm
// would install it from (a scoped @plur-ai mirror here), and when that registry
// gives no answer it names the registry and why. Real npm, local mirror; no
// request leaves 127.0.0.1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkOpencodePluginPublished, opencodeResolvableLines } from '../src/commands/doctor.js'
import { startMirror, npmSandbox, refusedPort, type Mirror, type NpmSandbox } from '../../core/test/npm-mirror.js'

const PKG = '@plur-ai/opencode'

describe('doctor: is the opencode plugin published, through the npm configuration', () => {
  const realFetch = globalThis.fetch
  const fetched: string[] = []
  let mirror: Mirror
  let box: NpmSandbox | undefined
  let restoreEnv: () => void = () => {}

  const useRegistry = (npmrc: string) => { box = npmSandbox(npmrc); restoreEnv = box.apply() }

  beforeEach(async () => {
    fetched.length = 0
    globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); throw new TypeError('fetch blocked in test') }) as typeof fetch
    mirror = await startMirror({ [PKG]: '9.8.7' })
  })
  afterEach(async () => {
    expect(fetched).toEqual([])
    globalThis.fetch = realFetch
    restoreEnv(); restoreEnv = () => {}
    box?.cleanup(); box = undefined
    await mirror.close()
  })

  const lines = async () => {
    const r = await checkOpencodePluginPublished(PKG, 1000)
    const pluginResolvable = r.state === 'published' ? 'yes' : r.state === 'not-published' ? 'no' : 'unknown'
    return { r, text: opencodeResolvableLines({ pluginResolvable, resolvedVia: r.state === 'published' ? 'npm registry' : null, registry: r.registry }).join('\n') }
  }

  it('published on the scoped mirror', async () => {
    useRegistry(`@plur-ai:registry=${mirror.url}\n`)
    const { r, text } = await lines()
    expect(r).toEqual({ state: 'published' })
    expect(mirror.requests).toEqual([`/${PKG}`])
    expect(text).toContain('resolves (npm registry)')
  })

  it('the mirror has no such package: names the mirror', async () => {
    const empty = await startMirror({})
    try {
      useRegistry(`@plur-ai:registry=${empty.url}\n`)
      const { r, text } = await lines()
      expect(r).toEqual({ state: 'not-published', registry: { host: empty.host, reason: `it has no ${PKG}` } })
      expect(text).toContain(`does NOT resolve — ${empty.host} has no such package.`)
    } finally { await empty.close() }
  })

  for (const [name, reason] of [['refused', 'connection refused'], ['HTTP 500', 'it answered HTTP 500'], ['timeout', 'timed out']] as const) {
    it(`unreachable (${name}): unknown, names the registry and why`, async () => {
      let host = mirror.host
      if (name === 'refused') host = `127.0.0.1:${await refusedPort()}`
      else mirror.setMode(name === 'timeout' ? 'hang' : '500')
      useRegistry(`@plur-ai:registry=http://${host}/\n`)
      const { r, text } = await lines()
      expect(r).toEqual({ state: 'unknown', registry: { host, reason } })
      expect(text).toContain(`? Could not reach ${host} to check whether ${PKG} is published (${reason}).`)
    })
  }
})
