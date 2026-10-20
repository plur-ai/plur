// Real local stores and loopback services; no production method is replaced.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { Plur } from '../../packages/core/src/index.js'
import { StubServer } from '../../packages/core/test/helpers/stub-server.js'
import { useEmbedder } from './store.js'
import { REPO, tsxLoader } from './agent-tools-hooks-cli.js'

export async function enterpriseFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-install-')))
  const store = join(home, '.plur'), repo = join(home, 'repo')
  for (const dir of [store, repo, join(home, 'tmp')]) mkdirSync(dir)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://git.example.test/team/app.git'])
  const stub = new StubServer('fixture-valid-key')
  const { url, token } = await stub.start()
  const scope = 'project:example/team/app'
  stub.setMe({ username: 'fixture', org_id: 'example', scopes: [scope], scopes_status: 'ok', key_expires_at: null })
  const entry = { url, token, scope, scopes: [scope], dial: 'always', enterprise: {}, discovery: {
    status: 'ok', username: 'fixture', key_expires_at: null, discovered_at: new Date().toISOString(),
    gitlab_host: 'git.example.test', project_paths: { [scope]: 'team/app' },
  } }
  const configure = (stores: unknown[] = [entry]) => writeFileSync(join(store, 'config.yaml'),
    JSON.stringify({ index: false, embeddings: { enabled: false }, auto_learn: false, stores }), { mode: 0o600 })
  configure()
  writeFileSync(join(store, 'folders.yaml'), JSON.stringify({ version: 1, folders: [{ path: repo, plur: 'on' }] }))
  useEmbedder('off')
  const instances: Plur[] = []
  const open = () => { const p = new Plur({ path: store, cwd: repo, autoDiscover: false }); instances.push(p); return p }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode'),
    PLUR_PATH: store, TMPDIR: join(home, 'tmp'), PLUR_AUTO_DISCOVER: '0', PLUR_DISABLE_EMBEDDINGS: '1',
    PLUR_REMOTE_RECALL: 'on', PLUR_HOOK_HYBRID: 'off', PLUR_RERANKER: 'off' }
  return { home, store, repo, stub, url, token, scope, entry, configure, open, env,
    async close() { for (const p of instances) await p.close(); await stub.stop(); rmSync(home, { recursive: true, force: true }) } }
}

// Unlike spawnSync, this leaves the eval's loopback server able to answer.
export async function sourceCli(args: string[], env: NodeJS.ProcessEnv, cwd: string, input = '') {
  const child = spawn(process.execPath, ['--import', tsxLoader(), join(REPO, 'packages/cli/src/index.ts'), ...args],
    { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  child.stdin.end(input)
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve)
    })
    return { status, stdout, stderr }
  } finally { clearTimeout(timer) }
}
