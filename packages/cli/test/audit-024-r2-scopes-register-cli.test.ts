/**
 * 0.24 review, round 2 (CLI side): `plur scopes register <scope>` and
 * `plur stores discover --register` add new stores, so under
 * `pinning.agents: request` or `deny` they follow `plur stores add`: a CLI
 * run by an agent (no terminal) is refused by core, and PLUR_ACTOR=owner
 * without a terminal is refused by the typed confirmation. Nothing is
 * registered when refused. Under `allow` both register as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import yaml from 'js-yaml'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const TOKEN = 'r2-scopes-token'
const BASE = 'group:example/eng'
const OTHER = 'group:example/comms'
let server: Server, url: string, home: string, root: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/v1/me' && req.headers.authorization === `Bearer ${TOKEN}`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ username: 'tester', org_id: 'example', role: 'developer', scopes: [BASE, OTHER] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

function config(agents: 'allow' | 'request' | 'deny'): void {
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    embeddings: { enabled: false },
    index: false,
    pinning: { agents },
    stores: [{ url, token: TOKEN, scope: BASE, shared: true, readonly: false }],
  }, { lineWidth: 120, noRefs: true }))
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-r2-scopes-cli-'))
  root = join(home, '.plur')
  mkdirSync(root)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const scopes = () => (((yaml.load(readFileSync(join(root, 'config.yaml'), 'utf8')) as { stores?: Array<{ scope?: string }> }).stores) ?? [])
  .map(s => s.scope)

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), ...args], {
    cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  const timer = setTimeout(() => child.kill(), 40000)
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    .finally(() => clearTimeout(timer))
  return { stdout, stderr, status }
}

describe('round 2: registering discovered scopes from the CLI under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: from an agent shell, scopes register and stores discover --register are refused`, async () => {
      config(agents)
      const one = await cli(['scopes', 'register', OTHER])
      expect(one.status).toBe(1)
      expect(one.stdout + one.stderr).toMatch(/reserved for the owner/)
      const all = await cli(['stores', 'discover', '--register'])
      expect(all.status).toBe(1)
      expect(all.stdout + all.stderr).toMatch(/reserved for the owner/)
      expect(scopes()).toEqual([BASE])
    }, 60_000)

    it(`${agents}: PLUR_ACTOR=owner without a terminal is refused for both`, async () => {
      config(agents)
      const one = await cli(['scopes', 'register', OTHER], { PLUR_ACTOR: 'owner' })
      expect(one.status).toBe(1)
      expect(one.stdout + one.stderr).toMatch(/pinning\.agents is "(request|deny)".*interactive terminal/)
      const all = await cli(['stores', 'discover', '--register'], { PLUR_ACTOR: 'owner' })
      expect(all.status).toBe(1)
      expect(all.stdout + all.stderr).toMatch(/interactive terminal/)
      expect(scopes()).toEqual([BASE])
    }, 60_000)
  }

  it('allow (default): both register from a shell as before', async () => {
    config('allow')
    const one = await cli(['scopes', 'register', OTHER])
    expect(one.status, one.stderr).toBe(0)
    expect(scopes()).toContain(OTHER)
    config('allow')
    const all = await cli(['stores', 'discover', '--register'])
    expect(all.status, all.stderr).toBe(0)
    expect(all.stdout).toContain(OTHER)
    expect(scopes()).toContain(OTHER)
  }, 60_000)
})
