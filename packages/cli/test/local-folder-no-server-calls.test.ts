import { beforeEach, afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync, spawn } from 'child_process'
import yaml from 'js-yaml'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { builtCliPath } from './helpers/built-cli.js'
import { hookFolderPolicy } from '../src/lib/folder-gate.js'
import { Plur } from '@plur-ai/core'

const CLI = builtCliPath(join(__dirname, '..'))
const SCOPE = 'project:acme/team/backend'
let home: string, repo: string, root: string, stub: StubServer
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-origin-cli-')))
  root = join(home, '.plur'); repo = join(home, 'repo')
  mkdirSync(root); mkdirSync(repo); mkdirSync(join(home, 'tmp'))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/team/backend.git'])
  stub = new StubServer('fixture-key')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    stores: [{ url, token, scope: 'user:acme:alice', scopes: ['user:acme:alice', SCOPE], enterprise: {},
      scope_settings: { [SCOPE]: { covers: ['acme.build'] }, 'user:acme:alice': { dial: 'always' } },
      discovery: { status: 'ok', scopes_status: 'ok', discovered_at: new Date().toISOString(),
        gitlab_host: 'gitlab.example.com', project_paths: { [SCOPE]: 'team/backend' } } }],
  }))
})
afterEach(async () => { await stub.stop(); rmSync(home, { recursive: true, force: true }) })

async function cli(args: string[], input?: unknown): Promise<string> {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: repo,
    env: { ...isolatedHomeEnv(home), TMPDIR: join(home, 'tmp'), PLUR_HOOK_HYBRID: 'on' },
    stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
  const timer = setTimeout(() => child.kill(), 25_000)
  child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject); child.on('close', resolve)
  }).finally(() => clearTimeout(timer))
  // A fresh home has no embedding model. Recall reports that degraded result
  // with exit 2; it must still exercise the real remote leg, without a download.
  expect(args[0] === 'recall' ? [0, 2] : [0], stderr).toContain(code)
  return stdout
}

it('hooks and the engine use the same project scope', () => {
  const plur = new Plur({ path: root, autoDiscover: false })
  expect(hookFolderPolicy(repo, { path: root }).scope).toBe(SCOPE)
  expect(plur.resolveFolderPolicy(repo).scope).toBe(SCOPE)
})

it('an unmatched repository makes no remote recall or append, even with routing metadata and an always-dial store', async () => {
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/team/other.git'])
  await cli(['hook-inject'], { cwd: repo, session_id: 'local-origin', prompt: 'fixture release procedure' })
  const learned = JSON.parse(await cli(['learn', 'fixture release procedure stays on this laptop', '--domain', 'acme.build', '--json']))
  await cli(['recall', 'fixture release procedure', '--json'])
  expect(learned.delivery).toBe('local')
  expect(stub.appendCalls).toBe(0)
  expect(stub.recallCalls).toBe(0)
}, 60_000)

it('a mapped repository sends both save and recall requests (positive control)', async () => {
  const learned = JSON.parse(await cli(['learn', 'fixture release procedure uses canary batches', '--json']))
  expect(learned.delivery).toBe('remote')
  expect(learned.scope).toBe(SCOPE)
  await cli(['hook-inject'], { cwd: repo, session_id: 'mapped-origin', prompt: 'fixture release procedure' })
  await cli(['recall', 'fixture release procedure', '--json'])
  expect(stub.appendCalls).toBeGreaterThan(0)
  expect(stub.recallCalls).toBeGreaterThan(0)
}, 60_000)

it('an explicitly named authorized scope still works from an unmatched repository', async () => {
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/team/other.git'])
  const learned = JSON.parse(await cli(['learn', 'explicit fixture release instruction', '--scope', SCOPE, '--json']))
  expect(learned.delivery).toBe('remote')
  expect(stub.appendCalls).toBe(1)
}, 60_000)
