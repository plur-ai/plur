/**
 * `plur pins` folds into `plur pin` (owner decision 2026-11-26): `plur pin`
 * with no id lists the pinned set, and `plur pin priority|review|audit|apply|undo`
 * are the former `plur pins` subcommands. `plur pins` keeps working for one
 * release. Pinning one engram (`plur pin <id>`) still takes only --scope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

let home: string, root: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-pin-sub-'))
  root = join(home, '.plur')
  mkdirSync(root)
  writeFileSync(join(root, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\ninjection_budget: 120\npinning:\n  agents: request\n')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function cli(args: string[]) {
  const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), ...args], {
    cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  const timer = setTimeout(() => child.kill(), 40000)
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    .finally(() => clearTimeout(timer))
  return { stdout, stderr, status }
}
const store = (actor: 'owner' | 'agent' = 'owner') => new Plur({ path: root, autoDiscover: false, actor })

describe('plur pin carries the pins subcommands', () => {
  it('plur pin with no id lists the pinned set, as plur pins does', async () => {
    await store('owner').learn('pinned rule about the deploy pipeline', { pinned: true, pinned_priority: 80 })
    const asked = await store('agent').learn('Always answer in plain language', { pinned: true })
    const viaPin = await cli(['pin', '--json'])
    expect(viaPin.status, viaPin.stderr).toBe(0)
    const viaPins = await cli(['pins', '--json'])
    expect(viaPins.status, viaPins.stderr).toBe(0)
    const a = JSON.parse(viaPin.stdout), b = JSON.parse(viaPins.stdout)
    expect(a.entries).toHaveLength(1)
    expect(a.entries.map((e: any) => e.id)).toEqual(b.entries.map((e: any) => e.id))
    expect(a.pending_requests.map((p: any) => p.id)).toEqual([asked.id])
    expect(a.budget).toBe(120)
  }, 60_000)

  it('plur pin list and plur pin --budget N are the report too', async () => {
    await store('owner').learn('pinned rule about the deploy pipeline', { pinned: true })
    const list = await cli(['pin', 'list', '--json'])
    expect(list.status, list.stderr).toBe(0)
    expect(JSON.parse(list.stdout).entries).toHaveLength(1)
    const budget = await cli(['pin', '--budget', '400', '--json'])
    expect(budget.status, budget.stderr).toBe(0)
    expect(JSON.parse(budget.stdout).budget).toBe(400)
  }, 60_000)

  it('plur pin review lists pending requests and plur pin priority reaches the priority command', async () => {
    const asked = await store('agent').learn('Always answer in plain language', { pinned: true })
    const review = await cli(['pin', 'review', '--json'])
    expect(review.status, review.stderr).toBe(0)
    expect(review.stdout).toContain(asked.id)
    const e = await store('owner').learn('pinned rule about releases', { pinned: true })
    // A piped CLI is an agent: raising a pin is refused under pinning.agents: request
    // (pins.test.ts covers the owner's path at a terminal). The refusal shows the
    // subcommand ran, and names the new command.
    const prio = await cli(['pin', 'priority', e.id, '70'])
    expect(prio.status).toBe(1)
    expect(prio.stderr).toContain(`plur pin priority ${e.id}`)
    expect((await store().getById(e.id))!.pinned_priority).not.toBe(70)
  }, 60_000)

  it('pinning one engram still refuses the report flags', async () => {
    const e = await store('owner').learn('Never push to main')
    const r = await cli(['pin', e.id, '--budget', '400'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/--budget/)
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
  }, 60_000)

  it('the help lists the subcommands under pin, not a separate pins command', async () => {
    const r = await cli(['--help'])
    const help = r.stdout + r.stderr
    expect(help).toMatch(/pin review/)
    expect(help).not.toMatch(/^\s+pins\s/m)
  }, 60_000)
})
