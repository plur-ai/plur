/**
 * `plur pin` / `plur unpin` / `plur pins` (overhaul D2, D3, W3) and the
 * `plur doctor` pin-overflow warning.
 *
 * The CLI at a terminal is the owner: its pins are never turned into
 * requests. Under pinning.agents request/deny, granting pins and applying a
 * proposal need a confirmation typed at a terminal (S1), so those steps run
 * under a pseudo-terminal here. The audit
 * asks the host model through `--llm-cmd` / PLUR_LLM_CMD and changes nothing;
 * apply goes through the change journal and undo restores the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { runInPty, ptyAvailable } from './helpers/pty.js'
import { AGENT_ENV_MARKERS } from '../src/plur.js'
import { printText } from '../src/commands/doctor.js'
import { printReport } from '../src/commands/pins.js'

/** Text output (a spawned CLI prints JSON when piped, so text is rendered in-process). */
function captureText(fn: () => void): string {
  let text = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => { text += c; return true }) as any)
  try { fn() } finally { spy.mockRestore() }
  return text
}

let home: string, root: string

function config(extra = ''): void {
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: request\n${extra}`)
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-pins-cli-'))
  root = join(home, '.plur')
  mkdirSync(root)
  config()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

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
/** The CLI at a terminal, answering the S1 confirmation with yes. Agent markers are stripped. */
async function ttyCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const full: NodeJS.ProcessEnv = { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...env }
  for (const k of AGENT_ENV_MARKERS) if (!(k in env)) delete full[k]
  if (!('PLUR_ACTOR' in env)) delete full.PLUR_ACTOR
  const r = await runInPty([process.execPath, builtCliPath(join(__dirname, '..')), ...args], { env: full, cwd: home, answer: 'yes' })
  const at = r.output.indexOf('{')
  return { status: r.status, output: r.output, json: () => JSON.parse(r.output.slice(at)) }
}
const store = (actor: 'owner' | 'agent' = 'owner') => new Plur({ path: root, autoDiscover: false, actor })

describe.skipIf(!ptyAvailable)('plur pin / unpin (owner)', () => {
  it('the owner pins and unpins under pinning.agents: request', async () => {
    const e = await store('owner').learn('Never push to main')
    const pinned = await ttyCli(['pin', e.id, '--json'])
    expect(pinned.status, pinned.output).toBe(0)
    expect(pinned.json().pinned).toBe(true)
    expect((await store().getById(e.id))!.pinned).toBe(true)
    const unpinned = await cli(['unpin', e.id, '--json'])
    expect(unpinned.status, unpinned.stderr).toBe(0)
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
  }, 60_000)

  it('PLUR_ACTOR=agent makes the CLI an agent: its pin becomes a request', async () => {
    const e = await store('owner').learn('Never push to main')
    const r = await ttyCli(['pin', e.id, '--json'], { PLUR_ACTOR: 'agent' })
    expect(r.status, r.output).toBe(0)
    expect(r.json().pinned).toBe(false)
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
  }, 60_000)
})

describe('plur pins (fit report, priority, review)', () => {
  it('lists pins with priority, cost, the share and the overflow, and pending requests', async () => {
    config('injection_budget: 120\n')
    const s = store('owner')
    for (let i = 0; i < 4; i++) await s.learn(`pinned rule ${i} about the deploy pipeline and its many careful checks`, { pinned: true, pinned_priority: 90 - i * 10 })
    const asked = await store('agent').learn('Always answer in plain language', { pinned: true })
    const r = await cli(['pins', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.budget).toBe(120)
    expect(out.share).toBe(60)
    expect(out.entries).toHaveLength(4)
    expect(out.entries[0]).toMatchObject({ priority: 90 })
    expect(typeof out.entries[0].cost).toBe('number')
    expect(out.overflow_count).toBeGreaterThan(0)
    expect(out.pending_requests.map((p: any) => p.id)).toEqual([asked.id])
    const text = captureText(() => printReport(out, out.pending_requests))
    expect(text).toMatch(/do not fit/)
    expect(text).toContain(asked.id)
  }, 60_000)

  it('pins priority sets a priority', async () => {
    const e = await store('owner').learn('Never push to main', { pinned: true })
    const r = await cli(['pins', 'priority', e.id, '80'])
    expect(r.status, r.stderr).toBe(0)
    expect((await store().getById(e.id))!.pinned_priority).toBe(80)
    expect((await cli(['pins', 'priority', e.id, '500'])).status).not.toBe(0)
  }, 60_000)

  it.skipIf(!ptyAvailable)('pins review approves and rejects requests as the owner', async () => {
    const a = await store('agent').learn('Always answer in plain language', { pinned: true })
    const b = await store('agent').learn('Prefer tabs', { pinned: true })
    const listed = await cli(['pins', 'review', '--json'])
    expect(JSON.parse(listed.stdout).pending.map((p: any) => p.id).sort()).toEqual([a.id, b.id].sort())
    expect((await ttyCli(['pins', 'review', 'approve', a.id])).status).toBe(0)
    // Without a terminal the CLI is an agent (S1), and an agent may not review
    // pin requests (S4): a piped reject is refused, the owner's goes through.
    expect((await cli(['pins', 'review', 'reject', b.id])).status).not.toBe(0)
    expect((await ttyCli(['pins', 'review', 'reject', b.id])).status).toBe(0)
    expect((await store().getById(a.id))!.pinned).toBe(true)
    expect((await store().getById(b.id))!.pinned).toBeUndefined()
    expect(await store().pendingPinRequests()).toEqual([])
  }, 60_000)
})

describe('plur pins audit / apply / undo (W3)', () => {
  // A stand-in for the host model: reads the prompt on stdin, answers JSON.
  function fakeModel(): string {
    const script = join(home, 'fake-model.cjs')
    writeFileSync(script, `
let input = ''
process.stdin.on('data', c => { input += c })
process.stdin.on('end', () => {
  const out = []
  const re = /- id: (\\S+)\\n  statement: (".*")/g
  let m
  while ((m = re.exec(input))) {
    const statement = JSON.parse(m[2])
    if (statement.startsWith('When deploying')) out.push({ id: m[1], class: 'situational', reason: 'docs only' })
    else out.push({ id: m[1], class: 'every-task', short_form: 'SHORT ' + statement.slice(0, 12) })
  }
  process.stdout.write('Here you go:\\n' + JSON.stringify(out))
})
`)
    return `"${process.execPath}" "${script}"`
  }

  async function seed() {
    const s = store('owner')
    const sit = await s.learn('When deploying the docs site, run the link checker first', { pinned: true })
    const every = await s.learn('Always answer in plain language and put ids in brackets', { pinned: true })
    const proh = await s.learn('Never print a secret value; compare sha256 fingerprints', { pinned: true })
    // One whole-corpus write normalises key order, so later byte comparisons compare rows.
    for (const e of [sit, every, proh]) await s.updateEngramAsync((await s.getById(e.id))!)
    return { sit, every, proh }
  }

  it('audit writes a proposal and leaves the store unchanged', async () => {
    const { sit, every, proh } = await seed()
    const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
    const out = join(home, 'proposal.json')
    const r = await cli(['pins', 'audit', '--out', out, '--llm-cmd', fakeModel()])
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
    const proposal = JSON.parse(readFileSync(out, 'utf8'))
    const byId = new Map(proposal.items.map((i: any) => [i.id, i]))
    expect((byId.get(sit.id) as any).action).toBe('unpin')
    expect((byId.get(every.id) as any).action).toBe('shorten')
    expect((byId.get(proh.id) as any).prohibition).toBe(true)
  }, 60_000)

  it('PLUR_LLM_CMD is the model command when --llm-cmd is absent; no command is an error', async () => {
    await seed()
    const out = join(home, 'p.json')
    expect((await cli(['pins', 'audit', '--out', out], { PLUR_LLM_CMD: fakeModel() })).status).toBe(0)
    const missing = await cli(['pins', 'audit', '--out', join(home, 'q.json')], { PLUR_LLM_CMD: '' })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr + missing.stdout).toContain('PLUR_LLM_CMD')
  }, 60_000)

  it.skipIf(!ptyAvailable)('apply needs --yes; --limit 1 changes exactly one engram; prohibition needs approved; undo restores', async () => {
    const { sit, every, proh } = await seed()
    const file = join(home, 'proposal.json')
    expect((await cli(['pins', 'audit', '--out', file, '--llm-cmd', fakeModel()])).status).toBe(0)
    const original = readFileSync(join(root, 'engrams.yaml'), 'utf8')

    const noYes = await cli(['pins', 'apply', file, '--limit', '1'])
    expect(noYes.status).not.toBe(0)
    expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(original)

    const trial = await ttyCli(['pins', 'apply', file, '--limit', '1', '--yes', '--json'])
    expect(trial.status, trial.output).toBe(0)
    const t = trial.json()
    expect(t.outcomes.filter((o: any) => o.status === 'applied').map((o: any) => o.id)).toEqual([sit.id])
    expect((await store().getById(sit.id))!.pinned).toBeUndefined()
    expect((await store().getById(every.id))!.statement).toBe(every.statement)

    const rest = await ttyCli(['pins', 'apply', file, '--yes', '--json'])
    expect(rest.status, rest.output).toBe(0)
    const r = rest.json()
    expect(r.outcomes.find((o: any) => o.id === proh.id).status).toBe('refused')
    expect((await store().getById(proh.id))!.statement).toBe(proh.statement)
    const short = (await store().getById(every.id))!
    expect(short.statement).toBe('SHORT Always answe')
    expect((short.structured_data as any).original_statement).toBe(every.statement)

    expect((await cli(['pins', 'undo', r.change_id])).status).toBe(0)
    expect((await cli(['pins', 'undo', t.change_id])).status).toBe(0)
    expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(original)
  }, 90_000)
})

describe('plur doctor pin overflow', () => {
  it('warns when pins overflow the pinned share', async () => {
    config('injection_budget: 120\n')
    const s = store('owner')
    for (let i = 0; i < 4; i++) await s.learn(`pinned rule ${i} about the deploy pipeline and its many careful checks`, { pinned: true })
    const r = await cli(['doctor', '--no-handshake', '--json'])
    const report = JSON.parse(r.stdout)
    expect(report.pinOverflow.overflow_count).toBeGreaterThan(0)
    expect(report.pinOverflow.share).toBe(60)
    expect(captureText(() => printText(report))).toMatch(/do not fit the pinned share/)
  }, 90_000)
})
