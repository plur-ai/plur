/**
 * `plur keys init` with no identity configured refuses instead of making a key
 * for `agent:unidentified`, which nothing ever signs with (0.23 audit, finding 16).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { assertSpawned, CLI_SPAWN_TIMEOUT } from './helpers/spawn.js'

const CLI = builtCliPath(join(__dirname, '..'))
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function run(args: string[]) {
  const store = mkdtempSync(join(tmpdir(), 'plur-keys-id-'))
  dirs.push(store)
  const r = assertSpawned(spawnSync('node', [CLI, ...args], {
    encoding: 'utf8', timeout: CLI_SPAWN_TIMEOUT,
    env: { ...process.env, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1' },
  }), `plur ${args.join(' ')}`)
  return { r, store }
}

describe('plur keys init needs an identity', () => {
  it('refuses with no identity configured, and makes no key', () => {
    const { r, store } = run(['keys', 'init'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/provenance\.identity/)
    expect(r.stdout + r.stderr).toMatch(/--identity/)
    const keys = join(store, 'keys')
    expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([])
  })

  it('makes a key for an identity given with --identity', () => {
    const { r, store } = run(['keys', 'init', '--identity', 'agent:test'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(readdirSync(join(store, 'keys')).length).toBe(1)
  })
})
