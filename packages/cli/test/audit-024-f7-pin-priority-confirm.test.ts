/**
 * Security audit 0.24 finding 7: under `pinning.agents: request` or `deny`,
 * raising a pin's priority with `plur pin priority` (and the `plur pins
 * priority` alias) needs the same confirmation typed at a terminal as `plur
 * pin` (S1). PLUR_ACTOR=owner alone — which an agent's shell can set — is not
 * enough. Lowering a priority strengthens nothing and is not asked; under
 * `allow` nothing is asked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { runInPty, ptyAvailable } from './helpers/pty.js'
import { AGENT_ENV_MARKERS } from '../src/plur.js'

let home: string, root: string

function config(agents: 'allow' | 'request' | 'deny'): void {
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-f7-'))
  root = join(home, '.plur')
  mkdirSync(root)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const store = () => new Plur({ path: root, autoDiscover: false, actor: 'owner' })
const priorityOf = async (id: string) => ((await store().getById(id)) as { pinned_priority?: number }).pinned_priority

async function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), ...args], {
    cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  const timer = setTimeout(() => child.kill(), 40000)
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    .finally(() => clearTimeout(timer))
  return { out: stdout + stderr, status }
}
async function ttyCli(args: string[]) {
  const full: NodeJS.ProcessEnv = { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' }
  for (const k of AGENT_ENV_MARKERS) delete full[k]
  delete full.PLUR_ACTOR
  return await runInPty([process.execPath, builtCliPath(join(__dirname, '..')), ...args], { env: full, cwd: home, answer: 'yes' })
}

describe('finding 7: plur pin priority asks the S1 confirmation under request/deny', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: PLUR_ACTOR=owner without a terminal cannot raise a priority (pin and pins forms)`, async () => {
      config(agents)
      const e = await store().learn('Never push to main', { pinned: true, pinned_priority: 50 })
      const viaPin = await cli(['pin', 'priority', e.id, '100'], { PLUR_ACTOR: 'owner' })
      expect(viaPin.status).toBe(1)
      expect(viaPin.out).toMatch(/interactive terminal/)
      const viaPins = await cli(['pins', 'priority', e.id, '100'], { PLUR_ACTOR: 'owner' })
      expect(viaPins.status).toBe(1)
      expect(viaPins.out).toMatch(/interactive terminal/)
      expect(await priorityOf(e.id)).toBe(50)
    }, 60_000)

    it(`${agents}: lowering a priority strengthens nothing and is not asked`, async () => {
      config(agents)
      const e = await store().learn('Never push to main', { pinned: true, pinned_priority: 80 })
      const r = await cli(['pin', 'priority', e.id, '20'], { PLUR_ACTOR: 'owner' })
      expect(r.status, r.out).toBe(0)
      expect(await priorityOf(e.id)).toBe(20)
    }, 60_000)
  }

  it.skipIf(!ptyAvailable)('deny: the owner at a terminal raises it after typing yes', async () => {
    config('deny')
    const e = await store().learn('Never push to main', { pinned: true, pinned_priority: 50 })
    const r = await ttyCli(['pin', 'priority', e.id, '100'])
    expect(r.status, r.output).toBe(0)
    expect(r.output).toMatch(/Type yes/)
    expect(await priorityOf(e.id)).toBe(100)
  }, 60_000)

  it('allow (default): PLUR_ACTOR=owner raises a priority without a question', async () => {
    config('allow')
    const e = await store().learn('Never push to main', { pinned: true, pinned_priority: 50 })
    const r = await cli(['pin', 'priority', e.id, '100'], { PLUR_ACTOR: 'owner' })
    expect(r.status, r.out).toBe(0)
    expect(await priorityOf(e.id)).toBe(100)
  }, 60_000)
})
