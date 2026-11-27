/**
 * Security audit 0.24 finding 4 (CLI side): under `pinning.agents: request`
 * or `deny`, registering a new store from the CLI is an owner action, as a
 * pin is. A CLI run by an agent (no terminal) is refused by core; with
 * PLUR_ACTOR=owner it still needs the confirmation typed at a terminal (S1),
 * because an agent can set that variable. `plur stores add` (path and url)
 * and `plur remote` are covered. Nothing is registered when refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import yaml from 'js-yaml'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { runInPty, ptyAvailable } from './helpers/pty.js'
import { AGENT_ENV_MARKERS } from '../src/plur.js'

let home: string, root: string, storeFile: string

function config(agents: 'allow' | 'request' | 'deny'): void {
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-f4-cli-'))
  root = join(home, '.plur')
  mkdirSync(root)
  storeFile = join(home, 'team', 'engrams.yaml')
  mkdirSync(join(home, 'team'))
  writeFileSync(storeFile, '[]\n')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const stores = () => ((yaml.load(readFileSync(join(root, 'config.yaml'), 'utf8')) as { stores?: unknown[] }).stores ?? [])

async function cli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = home) {
  const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), ...args], {
    cwd, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  const timer = setTimeout(() => child.kill(), 40000)
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    .finally(() => clearTimeout(timer))
  return { stdout, stderr, status }
}
async function ttyCli(args: string[]) {
  const full: NodeJS.ProcessEnv = { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' }
  for (const k of AGENT_ENV_MARKERS) delete full[k]
  delete full.PLUR_ACTOR
  return await runInPty([process.execPath, builtCliPath(join(__dirname, '..')), ...args], { env: full, cwd: home, answer: 'yes' })
}

describe('finding 4: registering a store from the CLI under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: plur stores add <path> from an agent shell is refused, nothing registered`, async () => {
      config(agents)
      const r = await cli(['stores', 'add', storeFile, 'global'])
      expect(r.status).toBe(1)
      expect(r.stdout + r.stderr).toMatch(/reserved for the owner/)
      expect(stores()).toEqual([])
    }, 60_000)

    it(`${agents}: PLUR_ACTOR=owner without a terminal is refused for path, url and plur remote`, async () => {
      config(agents)
      const path = await cli(['stores', 'add', storeFile, 'global'], { PLUR_ACTOR: 'owner' })
      expect(path.status).toBe(1)
      expect(path.stdout + path.stderr).toMatch(/pinning\.agents is "(request|deny)".*interactive terminal/)
      const url = await cli(['stores', 'add', '--url', 'http://127.0.0.1:1', '--token', 'tok', '--scope', 'group:example/eng'], { PLUR_ACTOR: 'owner' })
      expect(url.status).toBe(1)
      expect(url.stdout + url.stderr).toMatch(/interactive terminal/)
      // From a project folder: plur remote refuses to map $HOME itself.
      const remote = await cli(['remote', '--url', 'http://127.0.0.1:1', '--token', 'tok', '--scope', 'group:example/eng'], { PLUR_ACTOR: 'owner' }, join(home, 'team'))
      expect(remote.status).toBe(1)
      expect(remote.stderr + remote.stdout).toMatch(/interactive terminal/)
      expect(stores()).toEqual([])
    }, 60_000)
  }

  it.skipIf(!ptyAvailable)('deny: the owner at a terminal registers a store after typing yes', async () => {
    config('deny')
    const r = await ttyCli(['stores', 'add', storeFile, 'global'])
    expect(r.status, r.output).toBe(0)
    expect(r.output).toMatch(/Type yes/)
    expect(stores()).toHaveLength(1)
  }, 60_000)

  it('allow (default): plur stores add from a shell works as before, no question', async () => {
    config('allow')
    const r = await cli(['stores', 'add', storeFile, 'global'])
    expect(r.status, r.stderr).toBe(0)
    expect(stores()).toHaveLength(1)
  }, 60_000)
})
