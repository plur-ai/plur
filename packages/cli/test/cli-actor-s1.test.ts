/**
 * S1: an agent with a shell must not get around `pinning.agents: request|deny`
 * by running the CLI.
 *  - The CLI actor is 'agent' when an agent environment is detected
 *    (CLAUDECODE, Codex, Cursor agent, Gemini/Antigravity, opencode markers)
 *    or stdin is not a terminal — unless PLUR_ACTOR=owner is set.
 *  - Under request/deny, `plur pin`, `plur pins review approve`, `plur pins
 *    apply`, `consolidate --apply`, `enrich --apply` and `rescope --apply`
 *    additionally need a confirmation typed at an interactive terminal, even
 *    with PLUR_ACTOR=owner (an agent can set that variable too).
 *  - H11: `plur import` of pinned records needs that confirmation too; without
 *    it the records are imported unpinned (as pin requests under request).
 *  - H12: an undo that puts a pin back needs it as well.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur, pinRequestOf, PIN_AUDIT_PROPOSAL_KIND, PIN_AUDIT_PROPOSAL_VERSION } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { runInPty, ptyAvailable } from './helpers/pty.js'
import { resolveCliActor, setCliActor, agentEnvironmentMarker } from '../src/plur.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('resolveCliActor (S1)', () => {
  afterEach(() => setCliActor('owner'))
  const clean: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

  it('a terminal with no agent marker is the owner', () => {
    expect(resolveCliActor(clean, true)).toBe('owner')
  })
  it('stdin not a terminal → agent', () => {
    expect(resolveCliActor(clean, false)).toBe('agent')
  })
  it.each(['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI', 'ANTIGRAVITY_AGENT', 'OPENCODE'])('agent marker %s → agent, even at a terminal', (k) => {
    expect(agentEnvironmentMarker({ ...clean, [k]: '1' })).toBe(k)
    expect(resolveCliActor({ ...clean, [k]: '1' }, true)).toBe('agent')
  })
  it('an empty or "0" marker does not count', () => {
    expect(resolveCliActor({ ...clean, CLAUDECODE: '' }, true)).toBe('owner')
    expect(resolveCliActor({ ...clean, CLAUDECODE: '0' }, true)).toBe('owner')
  })
  it('PLUR_ACTOR=owner overrides detection; PLUR_ACTOR=agent always wins', () => {
    expect(resolveCliActor({ ...clean, CLAUDECODE: '1', PLUR_ACTOR: 'owner' }, false)).toBe('owner')
    expect(resolveCliActor({ ...clean, PLUR_ACTOR: 'agent' }, true)).toBe('agent')
  })
  it('hook commands stay agents', () => {
    setCliActor('agent')
    expect(resolveCliActor({ ...clean, PLUR_ACTOR: 'owner' }, true)).toBe('agent')
  })
})

let home: string, root: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-s1-'))
  root = join(home, '.plur')
  mkdirSync(root)
  writeFileSync(join(root, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: request\n')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const store = () => new Plur({ path: root, autoDiscover: false, actor: 'owner' })
const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...extra }
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI', 'ANTIGRAVITY_AGENT', 'OPENCODE']) {
    if (!(k in extra)) delete env[k]
  }
  if (!('PLUR_ACTOR' in extra)) delete env.PLUR_ACTOR
  return env
}

async function cli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  child.stdin.end('yes\n') // an agent piping its own "yes" must not count
  const timer = setTimeout(() => child.kill(), 40_000)
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    .finally(() => clearTimeout(timer))
  return { stdout, stderr, status }
}

describe('pinning.agents: request — no shell bypass (S1)', () => {
  it('plur pin from a non-terminal is refused, even with PLUR_ACTOR=owner and a piped yes', async () => {
    const e = await store().learn('Never push to main')
    for (const extra of [{}, { PLUR_ACTOR: 'owner' }, { CLAUDECODE: '1', PLUR_ACTOR: 'owner' }]) {
      const r = await cli(['pin', e.id, '--json'], baseEnv(extra))
      expect(r.status, JSON.stringify(extra) + r.stdout).not.toBe(0)
      expect(r.stderr + r.stdout).toMatch(/interactive terminal/)
      expect((await store().getById(e.id))!.pinned).toBeUndefined()
    }
  }, 120_000)

  it('pins review approve and pins apply from a non-terminal are refused', async () => {
    const asked = await new Plur({ path: root, autoDiscover: false, actor: 'agent' }).learn('Always answer in plain language', { pinned: true })
    const r = await cli(['pins', 'review', 'approve', asked.id], baseEnv({ PLUR_ACTOR: 'owner' }))
    expect(r.status).not.toBe(0)
    expect((await store().getById(asked.id))!.pinned).toBeUndefined()
    const file = join(home, 'proposal.json')
    writeFileSync(file, JSON.stringify({ kind: 'plur.pin-audit', items: [] }))
    const a = await cli(['pins', 'apply', file, '--yes'], baseEnv({ PLUR_ACTOR: 'owner' }))
    expect(a.status).not.toBe(0)
    expect(a.stderr + a.stdout).toMatch(/interactive terminal/)
  }, 120_000)

  it.each([
    ['consolidate', ['consolidate', '--apply', 'plan.json', '--yes']],
    ['enrich', ['enrich', '--apply', 'plan.json', '--yes']],
    ['rescope', ['rescope', '--apply', 'plan.json', '--yes']],
  ])('%s --apply from a non-terminal is refused', async (_n, args) => {
    writeFileSync(join(home, 'plan.json'), '{}')
    const r = await cli(args, baseEnv({ PLUR_ACTOR: 'owner' }))
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toMatch(/interactive terminal/)
  }, 60_000)

  it('under the default allow, a non-terminal plur pin still works (no confirmation)', async () => {
    writeFileSync(join(root, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    const e = await store().learn('Never push to main')
    const r = await cli(['pin', e.id, '--json'], baseEnv())
    expect(r.status, r.stderr).toBe(0)
    expect((await store().getById(e.id))!.pinned).toBe(true)
  }, 60_000)

  it.skipIf(!ptyAvailable)('at a terminal the owner confirms with yes and the pin lands; anything else refuses', async () => {
    const e = await store().learn('Never push to main')
    const no = await runInPty([process.execPath, CLI, 'pin', e.id], { env: baseEnv(), cwd: home, answer: 'no' })
    expect(no.status, no.output).not.toBe(0)
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
    const yes = await runInPty([process.execPath, CLI, 'pin', e.id], { env: baseEnv(), cwd: home, answer: 'yes' })
    expect(yes.status, yes.output).toBe(0)
    expect((await store().getById(e.id))!.pinned).toBe(true)
  }, 120_000)

  it.skipIf(!ptyAvailable)('at a terminal inside an agent environment, plur pin is a request (the actor is the agent)', async () => {
    const e = await store().learn('Prefer tabs')
    const r = await runInPty([process.execPath, CLI, 'pin', e.id], { env: baseEnv({ CLAUDECODE: '1' }), cwd: home, answer: 'yes' })
    expect(r.status, r.output).toBe(0)
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
    expect(r.output).toMatch(/NOT pinned/)
  }, 60_000)

  it('H11: plur import of a pinned record from a non-terminal imports it unpinned, as a pin request, and says so', async () => {
    const file = join(home, 'in.json')
    writeFileSync(file, JSON.stringify([
      { statement: 'Always run the linter before committing', pinned: true },
      { statement: 'Prefer short functions over long ones' },
    ]))
    const r = await cli(['import', '--from', 'generic', '--path', file, '--store', root], baseEnv({ PLUR_ACTOR: 'owner' }))
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const rows = await store().list({})
    const pinnedRow = rows.find(e => e.statement.startsWith('Always run the linter'))!
    expect(pinnedRow, JSON.stringify(rows)).toBeDefined()
    expect(pinnedRow.pinned).toBeUndefined()
    expect(pinRequestOf(pinnedRow)).not.toBeNull()
    expect(rows.find(e => e.statement.startsWith('Prefer short functions'))).toBeDefined()
    expect(r.stdout + r.stderr).toMatch(/not pinned/i)
  }, 60_000)

  it('H11: under deny, the pinned record is still imported, unpinned, with no error', async () => {
    writeFileSync(join(root, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: deny\n')
    const file = join(home, 'in.json')
    writeFileSync(file, JSON.stringify([{ statement: 'Always run the linter before committing', pinned: true }]))
    const r = await cli(['import', '--from', 'generic', '--path', file, '--store', root, '--json'], baseEnv({ PLUR_ACTOR: 'owner' }))
    expect(r.status, r.stderr + r.stdout).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.errors).toBe(0)
    expect(report.imported).toBe(1)
    expect(report.pins_not_confirmed).toBe(1)
    const row = (await store().list({})).find(e => e.statement.startsWith('Always run the linter'))!
    expect(row.pinned).toBeUndefined()
  }, 60_000)

  it.skipIf(!ptyAvailable)('H11: at a terminal the owner confirms with yes and the imported record is pinned', async () => {
    const file = join(home, 'in.json')
    writeFileSync(file, JSON.stringify([{ statement: 'Always run the linter before committing', pinned: true }]))
    const yes = await runInPty([process.execPath, CLI, 'import', '--from', 'generic', '--path', file, '--store', root], { env: baseEnv(), cwd: home, answer: 'yes' })
    expect(yes.status, yes.output).toBe(0)
    const row = (await store().list({})).find(e => e.statement.startsWith('Always run the linter'))!
    expect(row.pinned).toBe(true)
  }, 60_000)

  it('H12: plur pins undo that would re-pin an engram is refused from a non-terminal, even with PLUR_ACTOR=owner', async () => {
    const e = await store().learn('When deploying the docs site, run the link checker first', { pinned: true })
    const applied = await store().applyPinAudit(
      { kind: PIN_AUDIT_PROPOSAL_KIND, version: PIN_AUDIT_PROPOSAL_VERSION, items: [{ id: e.id, statement: e.statement, action: 'unpin' }] } as any,
      { actor: 'owner' },
    )
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
    const r = await cli(['pins', 'undo', applied.change!.id], baseEnv({ PLUR_ACTOR: 'owner' }))
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toMatch(/interactive terminal/)
    expect((await store().getById(e.id))!.pinned).toBeUndefined()
  }, 60_000)
})
