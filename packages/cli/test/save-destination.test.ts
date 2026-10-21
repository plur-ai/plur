import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { run } from '../src/commands/learn.js'

let home: string, root: string, repo: string, stub: StubServer
const scope = 'project:acme/team/backend'
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-cli-destination-')))
  root = join(home, '.plur'); repo = join(home, 'repo')
  mkdirSync(root); mkdirSync(repo)
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{ url, token, scope, shared: true }] }))
  writeFileSync(join(root, 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(repo)}\n    plur: on\n`)
})
afterEach(async () => { await stub.stop(); rmSync(home, { recursive: true, force: true }) })
it('built CLI JSON distinguishes a confirmed save from a queued one', async () => {
  const cli = async (statement: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, [builtCliPath(join(__dirname, '..')), 'learn', statement, '--scope', scope, '--json'], {
      cwd: repo, env: isolatedHomeEnv(home), timeout: 20000,
    })
    return JSON.parse(stdout)
  }
  expect((await cli('Release canaries detect deployment failures')).destination).toBe(`saved to ${scope} (server)`)
  stub.appendErrorResponse = { status: 503, body: 'temporarily unavailable' }
  expect((await cli('Database snapshots precede migrations')).destination).toContain(`queued for ${scope} — not on the server yet:`)
}, 30000)
it('quiet text still states when a team save stayed on this laptop', async () => {
  const out: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true }) as never)
  try { await run(['Keep a team note visible', '--scope', 'project:acme/missing'], { path: root, json: false, quiet: true }) }
  finally { spy.mockRestore() }
  expect(out.join('')).toContain('Saved: saved on this laptop only — no server store for project:acme/missing')
})
