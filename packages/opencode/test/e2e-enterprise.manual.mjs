#!/usr/bin/env node
// Manual acceptance gate for the ENTERPRISE half of @plur-ai/opencode (#1207):
// does a project's `.plur.yaml` remote config actually deliver team memory
// into a real opencode session?
//
// Run (token on STDIN — never in argv or env, where a model tool call could
// read it back out of `env`):
//
//   PLUR_E2E_REMOTE_URL=https://plur.example.io \
//   PLUR_E2E_REMOTE_SCOPE=group:acme/eng \
//   PLUR_E2E_QUESTION='Is prod deployed with Docker or over SSH?' \
//   PLUR_E2E_EXPECT='git pull,NOT Docker' \
//   your-secret-broker | node packages/opencode/test/e2e-enterprise.manual.mjs
//
// `e2e.manual.mjs` is the sibling gate for LOCAL recall and shares this
// harness shape (packed tarballs, isolated XDG dirs, copied auth, every tool
// denied). Two differences carry the whole point of this one:
//
//   1. The local store is empty AND has no stores configured, so a passing
//      run cannot be explained by local memory.
//   2. The work dir is a git repo whose `.plur.yaml` is written by the real
//      `plur init-remote`, which is the onboarding path a customer follows —
//      including the directory-trust grant the remote fields require.
//
// PLUR_E2E_QUESTION must be a question only the remote store can answer, and
// PLUR_E2E_EXPECT a comma-separated list of phrases that appear in those
// engrams. The assertion is on the INJECTED BLOCK (via a read-only observer
// plugin), not on the model's prose: the block is what this patch changes,
// and a model can phrase a correct answer any number of ways.
//
// Exactly 1 opencode invocation = 1 model call.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, rmSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MODEL = process.env.PLUR_E2E_MODEL || 'openai/gpt-5.5'
const MARKER = 'PLUR Memory System'

class GateFailure extends Error {}
function fail(label, detail) { throw new GateFailure(`FAIL [${label}]: ${detail}`) }
function step(msg) { console.log(`\n=== ${msg} ===`) }

/** Read the bearer token from stdin. Never logged, never written by us. */
function readTokenFromStdin() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    fail('setup', 'could not read stdin — pipe the enterprise token in, e.g. `creds get … | node …`')
  }
  const tok = raw.trim()
  if (!tok) fail('setup', 'stdin was empty — this gate reads the enterprise token from stdin')
  return tok
}

function requireEnv(name) {
  const v = process.env[name]
  if (!v) fail('setup', `${name} is required`)
  return v
}

function packOne(pkgName, destDir) {
  mkdirSync(destDir, { recursive: true })
  execFileSync('pnpm', ['--filter', pkgName, 'pack', '--pack-destination', destDir],
    { cwd: REPO_ROOT, encoding: 'utf8' })
  const tgz = readdirSync(destDir).filter(f => f.endsWith('.tgz'))
  if (tgz.length !== 1) fail(`pack:${pkgName}`, `expected one .tgz in ${destDir}, found ${tgz.join(', ') || '(none)'}`)
  return join(destDir, tgz[0])
}

async function main() {
  const token = readTokenFromStdin()
  const remoteUrl = requireEnv('PLUR_E2E_REMOTE_URL')
  const remoteScope = requireEnv('PLUR_E2E_REMOTE_SCOPE')
  const question = requireEnv('PLUR_E2E_QUESTION')
  const expect = requireEnv('PLUR_E2E_EXPECT').split(',').map(s => s.trim()).filter(Boolean)
  if (expect.length === 0) fail('setup', 'PLUR_E2E_EXPECT parsed to zero phrases')

  const root = mkdtempSync(join(tmpdir(), 'plur-oc-ent-'))
  console.log(`Temp root: ${root}`)

  try {
    const realAuthPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
    if (!existsSync(realAuthPath)) {
      fail('setup', `no opencode auth at ${realAuthPath} — run \`opencode auth login\` first`)
    }
    console.log(`Model: ${MODEL} | remote: ${remoteUrl} | scope: ${remoteScope}`)

    const harness = join(root, 'harness')
    const work = join(harness, 'repo')
    const pluginsDir = join(harness, 'plugins')
    const xdg = {
      config: join(root, 'xdg-config'), data: join(root, 'xdg-data'),
      cache: join(root, 'xdg-cache'), state: join(root, 'xdg-state'),
    }
    const plurStore = join(root, 'plur-store')
    const observerLog = join(root, 'observer.log')
    for (const d of [harness, work, pluginsDir, plurStore, ...Object.values(xdg)]) mkdirSync(d, { recursive: true })
    mkdirSync(join(xdg.data, 'opencode'), { recursive: true })
    copyFileSync(realAuthPath, join(xdg.data, 'opencode', 'auth.json'))

    step('Step 1: build core, opencode, cli')
    for (const pkg of ['@plur-ai/core', '@plur-ai/opencode', '@plur-ai/cli']) {
      execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 300_000 })
    }

    step('Step 2: pack and install the publishable artifacts')
    const coreTarball = packOne('@plur-ai/core', join(root, 'pack', 'core'))
    const opencodeTarball = packOne('@plur-ai/opencode', join(root, 'pack', 'opencode'))
    writeFileSync(join(harness, 'package.json'), JSON.stringify({
      name: 'plur-enterprise-e2e', private: true, version: '0.0.0',
      dependencies: { '@plur-ai/core': `file:${coreTarball}`, '@plur-ai/opencode': `file:${opencodeTarball}` },
    }, null, 2))
    execFileSync('npm', ['install', '--no-audit', '--no-fund'],
      { cwd: harness, stdio: 'pipe', timeout: 300_000 })

    step('Step 3: `plur init-remote` writes .plur.yaml and grants trust')
    // The product's own onboarding path, not a hand-written fixture: it also
    // verifies connectivity against /api/v1/me and refuses to write a config
    // it could not authenticate, so reaching Step 4 already proves the token.
    execFileSync('git', ['init', '-q', '.'], { cwd: work })
    const cliEntry = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js')
    if (!existsSync(cliEntry)) fail('setup', `CLI dist not found after build: ${cliEntry}`)
    const init = spawnSync('node',
      [cliEntry, 'init-remote', '--url', remoteUrl, '--token', token, '--scopes', remoteScope],
      { cwd: work, env: { ...process.env, PLUR_PATH: plurStore }, encoding: 'utf8', timeout: 60_000 })
    const initOut = `${init.stdout ?? ''}${init.stderr ?? ''}`.split(token).join('<TOKEN-REDACTED>')
    console.log(initOut.trim().split('\n').slice(0, 6).join('\n'))
    if (init.status !== 0) fail('init-remote', `exited ${init.status}:\n${initOut}`)

    step('Step 4: assert the local store cannot answer')
    // No engrams, and no stores: with both empty, remote is the ONLY route.
    writeFileSync(join(plurStore, 'config.yaml'), 'stores: []\n')
    const status = JSON.parse(execFileSync('node', [cliEntry, 'status'],
      { env: { ...process.env, PLUR_PATH: plurStore }, encoding: 'utf8' }))
    if (status.engram_count !== 0) fail('isolation', `local store is not empty (${status.engram_count} engrams) — a pass would prove nothing`)
    if ((status.config?.stores ?? []).length !== 0) fail('isolation', `local store has ${status.config.stores.length} store(s) configured — a pass would prove nothing`)
    console.log('local store: 0 engrams, 0 stores')

    step('Step 5: write opencode.json and the read-only observer')
    writeFileSync(join(harness, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      // Real plugin first so the observer sees what it pushed. Loaded by path
      // for the same reason as the sibling gate: opencode resolves a bare
      // package name from the npm registry, which would exercise the
      // PUBLISHED plugin rather than this working tree's.
      plugin: ['./node_modules/@plur-ai/opencode/dist/index.js', './plugins/observer.mjs'],
      share: 'disabled',
      autoupdate: false,
      // Context must be the only possible source of the answer.
      tools: {
        bash: false, read: false, grep: false, glob: false, list: false,
        edit: false, write: false, patch: false, webfetch: false, websearch: false,
        task: false, skill: false, todowrite: false, agent: false,
      },
    }, null, 2))
    writeFileSync(join(pluginsDir, 'observer.mjs'), `// PLUR enterprise e2e observer — read-only. Logs the rendered PLUR block so
// the gate can assert on what was injected, not on the model's prose.
import { appendFileSync } from 'node:fs'
const LOG = process.env.PLUR_E2E_OBSERVER_LOG
const MARKER = ${JSON.stringify(MARKER)}
export const PlurEnterpriseObserver = async () => ({
  'experimental.chat.system.transform': async (input, output) => {
    const block = (output.system || []).find(s => typeof s === 'string' && s.includes(MARKER))
    try {
      appendFileSync(LOG, \`SYSTEM session=\${input?.sessionID ?? 'unknown'} present=\${Boolean(block)} chars=\${block ? block.length : 0}\\n\${block ?? ''}\\n\`)
    } catch { /* best-effort */ }
  },
})
export default PlurEnterpriseObserver
`)
    writeFileSync(observerLog, '')

    step('Step 6: one live opencode session')
    // Minimal env allowlist, NOT ...process.env — the sibling gate observed
    // the agent run `env` while exploring, and a blanket spread would hand
    // every ambient secret to a model tool call. The token is NOT here: it
    // reached init-remote above and now lives only in the temp .plur.yaml,
    // which is what the plugin is supposed to read.
    const SAFE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME']
    const env = {}
    for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]
    Object.assign(env, {
      PWD: work, // opencode prefers PWD over the physical cwd
      OPENCODE_CONFIG_DIR: harness,
      OPENCODE_CONFIG: join(harness, 'opencode.json'),
      XDG_CONFIG_HOME: xdg.config, XDG_DATA_HOME: xdg.data,
      XDG_CACHE_HOME: xdg.cache, XDG_STATE_HOME: xdg.state,
      PLUR_PATH: plurStore,
      PLUR_DEBUG: '1',
      PLUR_E2E_OBSERVER_LOG: observerLog,
      // The remote leg sends query TEXT and the server embeds, so the local
      // embedder is dead weight here — and loading it inside the opencode
      // process has OOM-killed the sibling gate on a loaded machine.
      ...(process.env.PLUR_E2E_FULL ? {} : { PLUR_DISABLE_EMBEDDINGS: '1' }),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    })
    console.log(`question: ${question}`)
    const run = spawnSync('opencode',
      ['run', '--dir', work, '--model', MODEL, '--title', 'plur-enterprise-e2e', question],
      { cwd: work, env, encoding: 'utf8', timeout: 180_000 })
    const answer = (run.stdout ?? '').trim()
    const stderr = (run.stderr ?? '')
    console.log(`--- model answer ---\n${answer}`)
    const debugLines = stderr.split('\n').filter(l => l.includes('[plur:opencode]'))
    console.log(`--- plugin debug ---\n${debugLines.join('\n') || '(none)'}`)
    if (run.status !== 0) fail('session', `opencode exited ${run.status}\n${stderr.slice(0, 2000)}`)

    step('Assertion 1: the remote engrams reached the injected block')
    const obs = existsSync(observerLog) ? readFileSync(observerLog, 'utf8') : ''
    if (!obs.includes('SYSTEM ')) {
      fail('injection-live', `the observer's system.transform never fired — harness contract may have moved:\n${obs}`)
    }
    if (!obs.includes('present=true')) {
      fail('injection-live', `no PLUR block was injected into system[]:\n${obs.slice(0, 1000)}`)
    }
    const missing = expect.filter(p => !obs.includes(p))
    if (missing.length > 0) {
      fail('remote-recall', `injected block is missing expected remote phrase(s): ${missing.join(', ')}. ` +
        `The local store was empty, so this means the remote leg did not deliver. Block:\n${obs.slice(0, 2000)}`)
    }
    console.log(`PASS: every expected remote phrase is in the injected block (${expect.join(', ')})`)

    step('Assertion 2: the host was actually dialed')
    // Independent of the block: the breaker's own state file records a real
    // POST /api/v1/recall outcome per host, so a green assertion 1 that came
    // from anywhere else cannot fake this.
    const healthPath = join(plurStore, 'cache', 'remote-health.json')
    if (!existsSync(healthPath)) {
      fail('dial', `no ${healthPath} — no remote host was ever dialed`)
    }
    const health = JSON.parse(readFileSync(healthPath, 'utf8'))
    console.log(JSON.stringify(health.hosts ?? health, null, 2).slice(0, 600))
    const hostEntry = Object.entries(health.hosts ?? {}).find(([h]) => remoteUrl.startsWith(h) || h.startsWith(remoteUrl))
    if (!hostEntry) fail('dial', `${remoteUrl} has no entry in the remote health state`)
    if (hostEntry[1]?.last_state !== 'ok') {
      fail('dial', `${remoteUrl} last_state is ${JSON.stringify(hostEntry[1]?.last_state)}, expected "ok"`)
    }
    console.log(`PASS: ${hostEntry[0]} dialed, last_state=ok`)

    console.log(`\nPASS: enterprise team memory reached a real opencode session (model=${MODEL}, 1 invocation)`)
  } catch (err) {
    if (err instanceof GateFailure) {
      console.error(`\n${err.message}`)
      process.exitCode = 1
      return
    }
    throw err
  } finally {
    // The temp tree holds BOTH a copy of the user's opencode auth and a
    // .plur.yaml carrying the enterprise token. Removing it is not tidiness.
    step('Cleanup')
    rmSync(root, { recursive: true, force: true })
    console.log(`Removed ${root}`)
  }
}

await main()
