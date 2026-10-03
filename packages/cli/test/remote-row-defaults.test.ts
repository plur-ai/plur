/**
 * Guard: `plur recall` and `plur inject` with a team store whose rows lack `tags`
 * and `activation` (#1563 review, T1): they answer, instead of failing with
 * "engram.tags is not iterable" / "reading 'retrieval_strength'".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TEAM = 'group:test'
let stub: StubServer
let dir: string
let home: string

beforeAll(async () => {
  stub = new StubServer('t')
  const { url } = await stub.start()
  dir = mkdtempSync(join(tmpdir(), 'plur-cli-remote-defaults-'))
  home = mkdtempSync(join(tmpdir(), 'plur-cli-remote-defaults-home-'))
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "t"\n    scope: "${TEAM}"\n`)
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [TEAM] })
  stub.seedEngram({ id: 'ENG-2026-01-01-911', scope: TEAM, status: 'active', data: { statement: 'zebra deploys go through the blue lane', type: 'behavioral' } })
  // The server-side recall answer, with neither tags nor activation.
  stub.recallRows = [{ id: 'ENG-2026-01-01-911', scope: TEAM, status: 'active', statement: 'zebra deploys go through the blue lane', score: 1 }]
})
afterAll(async () => {
  await stub.stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, PLUR_PATH: dir, XDG_CONFIG_HOME: join(home, '.config'), PLUR_DISABLE_EMBEDDINGS: '1' },
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('CLI recall and inject over team rows without tags or activation (#1563 review, T1)', () => {
  it('plur recall answers', () => {
    const r = cli(['recall', 'zebra deploys', '--scope', TEAM, '--json'])
    // A cold CLI process does not load the team rows into its cache, so this
    // guards the answer, not the rows: it must not fail on them.
    expect(r.stderr + r.stdout).not.toMatch(/not iterable|retrieval_strength/)
    expect(r.status === 0 || r.status === 2, r.stderr).toBe(true)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  it('plur inject answers', () => {
    const r = cli(['inject', '--json', 'zebra deploys', '--scope', TEAM])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toMatch(/not iterable|retrieval_strength/)
  })
})
