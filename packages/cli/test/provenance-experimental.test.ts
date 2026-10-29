/**
 * Session manifests and Swarm storage are experimental in 0.23, and every
 * manifest check says so — a pass included, so nobody reads a test feature's
 * OK as a settled guarantee.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function verify(args: string[]): Record<string, unknown> {
  const store = mkdtempSync(join(tmpdir(), 'plur-exp-'))
  dirs.push(store)
  const r = spawnSync('node', [CLI, 'verify', '--manifest', ...args, '--json'], {
    env: { ...process.env, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1' },
    encoding: 'utf8',
  })
  return JSON.parse(r.stdout)
}

describe('manifest checks are labelled experimental', () => {
  it('a check of a local manifest file says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-exp-m-'))
    dirs.push(dir)
    const file = join(dir, 'session.json')
    writeFileSync(file, JSON.stringify({ schema: 'plur/session-manifest/v1', session_id: 's1', actor: 'unidentified', window: { from: null, to: null }, engrams: [], created_at: '2026-10-29T00:00:00.000Z' }))
    expect(String(verify([file]).experimental)).toMatch(/experimental/i)
  })

  it('a check that cannot run says so too', () => {
    expect(String(verify([join(tmpdir(), 'no-such-manifest.json')]).experimental)).toMatch(/experimental/i)
  })
})
