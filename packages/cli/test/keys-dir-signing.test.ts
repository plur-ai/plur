/**
 * The private key `plur keys init` writes is the one checkpoints are signed
 * with (0.23 code review, finding 8). One location for both: PLUR_KEYS_DIR,
 * else <store>/keys. `--keys-dir` used to write somewhere signing never
 * looked, so every checkpoint went unsigned without a word; it is refused.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { assertSpawned, CLI_SPAWN_TIMEOUT } from './helpers/spawn.js'

const CLI = builtCliPath(join(__dirname, '..'))
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function plur(store: string, args: string[], env: Record<string, string> = {}) {
  return assertSpawned(spawnSync('node', [CLI, ...args], {
    encoding: 'utf8', timeout: CLI_SPAWN_TIMEOUT,
    env: { ...process.env, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1', ...env },
  }), `plur ${args.join(' ')}`)
}

describe('the signing key lives where keys init put it', () => {
  it('with PLUR_KEYS_DIR, keys init writes there and checkpoint signs with it', () => {
    const store = tmp('plur-keysdir-store-')
    const keys = tmp('plur-keysdir-keys-')
    writeFileSync(join(store, 'config.yaml'), 'provenance:\n  identity: agent:test\n')
    expect(plur(store, ['learn', 'Release notes are written in plain language']).status).toBe(0)
    const init = plur(store, ['keys', 'init'], { PLUR_KEYS_DIR: keys })
    expect(init.status, init.stdout + init.stderr).toBe(0)
    expect(readdirSync(keys).length, 'the key is not in PLUR_KEYS_DIR').toBe(1)
    expect(existsSync(join(store, 'keys')) ? readdirSync(join(store, 'keys')) : []).toEqual([])
    const cp = plur(store, ['checkpoint', '--json'], { PLUR_KEYS_DIR: keys })
    expect(cp.status, cp.stdout + cp.stderr).toBe(0)
    expect(JSON.parse(cp.stdout).signature, 'the checkpoint was not signed with the key keys init made').toBeTruthy()
  })

  it('--keys-dir is refused, naming PLUR_KEYS_DIR, and writes no key', () => {
    const store = tmp('plur-keysdir-store-')
    const keys = tmp('plur-keysdir-keys-')
    const r = plur(store, ['keys', 'init', '--identity', 'agent:test', '--keys-dir', keys])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/PLUR_KEYS_DIR/)
    expect(readdirSync(keys)).toEqual([])
  })
})

describe('plur checkpoint --session', () => {
  it('records the session id in the checkpoint', () => {
    const store = tmp('plur-cp-session-')
    expect(plur(store, ['learn', 'Release notes are written in plain language']).status).toBe(0)
    const cp = plur(store, ['checkpoint', '--session', 'sess-123', '--json'])
    expect(cp.status, cp.stdout + cp.stderr).toBe(0)
    expect(JSON.parse(cp.stdout).session_id).toBe('sess-123')
  })
})

describe('plur checkpoint when the checkpoint line cannot be written (0.23 code review, finding 3)', () => {
  it('exits non-zero and prints no hash to anchor', () => {
    const store = tmp('plur-cp-unwritten-')
    expect(plur(store, ['learn', 'Release notes are written in plain language']).status).toBe(0)
    // The month file the checkpoint would append to is a directory: the append fails.
    const month = new Date().toISOString().slice(0, 7)
    rmSync(join(store, 'history', `${month}.jsonl`), { force: true })
    mkdirSync(join(store, 'history', `${month}.jsonl`), { recursive: true })
    const cp = plur(store, ['checkpoint'])
    expect(cp.status, cp.stdout + cp.stderr).not.toBe(0)
    expect(cp.stdout + cp.stderr).toMatch(/not written/i)
    expect(cp.stdout).not.toMatch(/anchor this/)
  })
})
