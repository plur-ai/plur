import { afterEach, beforeEach, expect, it } from 'vitest'
import { Plur } from '@plur-ai/core'
import { createServer, type Server } from 'http'
import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..')), TEAM = 'project:example/team/app'
let root: string, plur: Plur, server: Server, url: string, ids: string[], writes: string[]
let response: 'mixed' | 'queued' | 'failed' | 'held'
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-upload-cli-')))
  writeFileSync(join(root, 'config.yaml'), 'index: false\nembeddings:\n  enabled: false\n')
  plur = new Plur({ path: root, autoDiscover: false }); writes = []; response = 'mixed'
  ids = []
  for (const [statement, scope] of [['First team memory', TEAM], ['Second team memory', TEAM], ['Personal preference', 'global']]) {
    ids.push((await plur.learn(statement, { scope })).id)
  }
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST' && req.url === '/api/v1/engrams') {
      let body = ''; for await (const chunk of req) body += chunk
      const data = JSON.parse(body); writes.push(data.statement)
      res.statusCode = response === 'queued' ? 503 : response === 'failed' ? 403 : 201
      res.end(JSON.stringify({ id: `ENG-SERVER-00${writes.length}`, deduplicated: data.statement.startsWith('Second'), review_required: response === 'held' })); return
    }
    res.end(JSON.stringify({ engrams: [] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  register()
})
function register(readonly = false) {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{ url, token: 'fixture-key', scopes: [TEAM], enterprise: {}, readonly }] }))
}
afterEach(async () => { plur.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
async function cli(args: string[]) {
  const child = spawn(process.execPath, [CLI, 'upload', ...args, '--path', root, '--json'], {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, '.config'), CODEX_HOME: join(root, '.codex'), PLUR_PATH: root, PLUR_AUTO_DISCOVER: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { code, stdout, stderr }
}
it('previews eligible scopes without changing memory or configuration bytes', async () => {
  const before = ['config.yaml', 'engrams.yaml'].map(p => readFileSync(join(root, p)))
  const run = await cli([]); expect(run.code, run.stderr).toBe(0)
  const out = JSON.parse(run.stdout)
  expect(out.summary).toContain('2 of 3 memories can go to a team scope')
  expect(out.proposals.map((x: any) => x.id)).toEqual(ids.slice(0, 2))
  expect(out.not_sent).toContainEqual({ id: ids[2], reason: 'stays local — no authorized scope' })
  expect(writes).toEqual([])
  expect(['config.yaml', 'engrams.yaml'].map(p => readFileSync(join(root, p)))).toEqual(before)
})
it('sends only proposed rows and reports sent and duplicate receipts separately', async () => {
  const run = await cli(['--yes']); expect(run.code, run.stderr).toBe(0)
  const out = JSON.parse(run.stdout)
  expect(out.counts).toEqual({ sent: 1, queued: 0, already_on_server: 1, held_for_review: 0, demoted_secret: 0, failed: 0 })
  expect(out.not_sent).toEqual([{ id: ids[2], reason: 'stays local — no authorized scope' }])
  expect(writes).toEqual(['First team memory', 'Second team memory'])
})
it('limits selection without silently including other proposed rows', async () => {
  const run = await cli(['--yes', '--only', ids[1]])
  expect(run.code, run.stderr).toBe(0)
  expect(writes).toEqual(['Second team memory'])
  expect(JSON.parse(run.stdout).not_sent).toContainEqual({ id: ids[0], reason: 'not selected' })
})
it.each(['ENG-MISSING-001', '', 'ENG-MISSING-001,'])('refuses invalid selection %j before any write', async value => {
  const run = await cli(['--yes', '--only', value])
  expect(run.code).toBe(1); expect(writes).toEqual([])
})
it('does not propose a readonly route', async () => {
  register(true)
  const run = await cli(['--yes']); expect(run.code, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout).proposals).toEqual([]); expect(writes).toEqual([])
})
it.each(['conflict', 'local'])('does not propose a scope whose effective route is %s', async kind => {
  const config = JSON.parse(readFileSync(join(root, 'config.yaml'), 'utf8'))
  const scope = kind === 'local' ? 'user:example:member' : TEAM
  if (kind === 'local') {
    const path = join(root, 'engrams.yaml')
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(TEAM, scope))
    config.stores[0].scopes = [scope]
  }
  config.stores.push(kind === 'conflict' ? { url: url + '/other', scope, token: 'fixture-key' } : { path: join(root, 'other.yaml'), scope })
  writeFileSync(join(root, 'config.yaml'), JSON.stringify(config))
  const run = await cli([]); expect(run.code, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout).proposals).toEqual([])
  expect(writes).toEqual([])
})
it('does not print private YAML when candidate loading fails', async () => {
  writeFileSync(join(root, 'engrams.yaml'), 'engrams: [private-fixture-sentinel: [\n')
  const run = await cli([])
  expect(run.code).toBe(1)
  expect(run.stdout + run.stderr).not.toContain('private-fixture-sentinel')
  expect(writes).toEqual([])
})
it.each([['queued', 0], ['failed', 1], ['held', 0]] as const)('counts %s outcomes and identifies undelivered rows', async (reply, code) => {
  response = reply
  const run = await cli(['--yes']); expect(run.code, run.stderr).toBe(code)
  const out = JSON.parse(run.stdout), outcome = reply === 'held' ? 'held_for_review' : reply
  expect(out.counts[outcome]).toBe(2)
  expect(out.results.every((r: any) => typeof r.destination === 'string' && r.destination.length > 0)).toBe(true)
  if (reply === 'queued') expect(out.results[0].destination).toContain('not on the server yet')
  if (reply === 'held') expect(out.results[0].destination).toContain('held for review')
  expect(out.not_sent.map((r: any) => r.id)).toEqual(expect.arrayContaining(ids))
})
it('counts only authorized proposals for initialization', async () => {
  const { countUploadCandidates } = await import('../src/commands/upload.js')
  expect(await countUploadCandidates(plur, [TEAM])).toBe(2)
  expect(await countUploadCandidates(plur, [])).toBe(0)
})
it('refuses unknown options instead of uploading', async () => {
  const run = await cli(['--yes', '--dry-run'])
  expect(run.code).toBe(1); expect(writes).toEqual([])
})
