import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync, spawn } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

let home: string, root: string, repo: string, stub: StubServer
const scope = 'project:acme/team/backend'
const line = `PLUR → server as fixture-user · saving to ${scope}`
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-hook-server-')))
  root = join(home, '.plur'); repo = join(home, 'repo')
  mkdirSync(root); mkdirSync(repo); mkdirSync(join(home, 'tmp'))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/team/backend.git'])
  stub = new StubServer('fixture-token')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{
    url, token, scope, scopes: [scope], enterprise: {}, discovery: { status: 'ok', username: 'fixture-user',
      key_expires_at: null, discovered_at: new Date().toISOString(), gitlab_host: 'gitlab.example.com', project_paths: { [scope]: 'team/backend' } },
  }] }))
  writeFileSync(join(root, 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(repo)}\n    plur: on\n`)
})
afterEach(async () => { await stub.stop(); rmSync(home, { recursive: true, force: true }) })
async function hook(command: string, extra: string[] = [], source = 'startup') {
  const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), command, ...extra], {
    cwd: repo, env: { ...isolatedHomeEnv(home), TMPDIR: join(home, 'tmp'), PLUR_HOOK_HYBRID: 'off' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
  const timer = setTimeout(() => child.kill(), 25000)
  child.stdin.end(JSON.stringify({ session_id: 'fixture-session', conversation_id: 'fixture-session', cwd: repo,
    workspace_roots: [repo], source, hook_event_name: command === 'hook-inject' ? 'UserPromptSubmit' : 'SessionStart', prompt: 'Plan the next deployment' }))
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    .finally(() => clearTimeout(timer))
  expect(code, stderr).toBe(0)
  return stdout
}
it.each([
  ['claude', 'hook-inject'], ['codex', 'hook-codex-session-start'], ['cursor', 'hook-cursor-session-start'],
])('%s session start reports the cached destination and records that its hook ran', async (tool, command) => {
  const started = Date.now()
  expect(await hook(command)).toContain(line)
  const runs = JSON.parse(readFileSync(join(root, 'hook-runs.json'), 'utf8'))
  expect(Date.parse(runs[tool])).toBeGreaterThanOrEqual(started)
  expect(Date.parse(runs[tool])).toBeLessThanOrEqual(Date.now())
  expect(stub.recallCalls).toBe(0)
  expect(stub.meCalls).toBe(0)
}, 30000)
it('ordinary prompts and rehydration do not repeat the server line', async () => {
  expect(await hook('hook-inject')).toContain(line)
  expect(await hook('hook-inject')).not.toContain('PLUR → server')
  expect(await hook('hook-inject', ['--rehydrate'])).not.toContain('PLUR → server')
  expect(await hook('hook-codex-session-start', [], 'compact')).not.toContain('PLUR → server')
}, 30000)
it('a configured local-only installation has no enterprise line', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false } }))
  expect(await hook('hook-codex-session-start')).not.toContain('PLUR → server')
}, 30000)
it('a trusted Claude hook records execution in an ask folder', async () => {
  const mode = 'ask'
  writeFileSync(join(root, 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(repo)}\n    plur: ${mode}\n`)
  const output = await hook('hook-inject')
  expect(output).not.toContain('PLUR → server')
  expect(Number.isFinite(Date.parse(JSON.parse(readFileSync(join(root, 'hook-runs.json'), 'utf8')).claude))).toBe(true)
}, 30000)

it.each(['hook-inject', 'hook-codex-session-start', 'hook-cursor-session-start'])('%s does not record execution in an off folder', async command => {
  writeFileSync(join(root, 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(repo)}\n    plur: off\n`)
  expect(await hook(command)).not.toContain('PLUR → server')
  expect(() => readFileSync(join(root, 'hook-runs.json'))).toThrow(/ENOENT/)
}, 30000)

it.each(['hook-inject', 'hook-codex-session-start'])('%s does not record execution when the folder map is unreadable', async command => {
  writeFileSync(join(root, 'folders.yaml'), 'folders: [broken')
  expect(await hook(command)).not.toContain('PLUR → server')
  expect(() => readFileSync(join(root, 'hook-runs.json'))).toThrow(/ENOENT/)
}, 30000)
