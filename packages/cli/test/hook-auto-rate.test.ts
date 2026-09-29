/**
 * #1310 — every editor's end-of-turn hook rates the engrams its inject hook
 * delivered, from the reply text, as ranking-only (`source: "auto"`) feedback.
 *
 * Each case drives the REAL inject hook for that editor (so the recording of
 * injected ids is exercised, not simulated), then the end-of-turn hook with a
 * reply that quotes the engram, then reads the store back.
 *
 * Everything runs against a temp HOME, PLUR_PATH and TMPDIR.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const STATEMENT = 'Always run the zebra-quartz migration before deploying the invoice service'

interface Env { root: string; project: string; plurPath: string; env: NodeJS.ProcessEnv }

function setup(): Env {
  const root = mkdtempSync(join(tmpdir(), 'plur-auto-rate-'))
  const project = join(root, 'project')
  const plurPath = join(root, '.plur')
  mkdirSync(join(project, '.cursor'), { recursive: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const mcp = JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } })
  writeFileSync(join(project, '.mcp.json'), mcp)
  writeFileSync(join(project, '.cursor', 'mcp.json'), mcp)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    TMPDIR: join(root, 'tmp'),
    PLUR_PATH: plurPath,
    PLUR_DISABLE_EMBEDDINGS: '1',
    PLUR_HOOK_HYBRID_DEADLINE_MS: '1',
  }
  delete env.CLAUDE_SESSION_ID
  delete env.PLUR_AUTO_RATE
  delete env.PLUR_AUTO_CAPTURE
  return { root, project, plurPath, env }
}

function cli(e: Env, args: string[], input: unknown, extraEnv: Record<string, string> = {}) {
  const r = runCli(process.execPath, [CLI, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 60_000,
    cwd: e.project,
    env: { ...e.env, ...extraEnv },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status }
}

function engrams(e: Env): Array<Record<string, any>> {
  const doc = yaml.load(readFileSync(join(e.plurPath, 'engrams.yaml'), 'utf8')) as { engrams?: any[] }
  return doc?.engrams ?? []
}

function history(e: Env): Array<Record<string, any>> {
  const dir = join(e.plurPath, 'history')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
}

function seed(e: Env, statement: string = STATEMENT): string {
  const r = cli(e, ['learn', statement, '--scope', 'global', '--json'], '')
  expect(r.status, r.stderr).toBe(0)
  const id = engrams(e).find(x => x.statement === statement)?.id
  expect(id).toBeTruthy()
  return id
}

const QUOTING_REPLY = `Following your note — ${STATEMENT}. Done, the deploy is green.`

describe('hook-auto-rate (#1310)', () => {
  let e: Env
  beforeEach(() => { e = setup() })
  afterEach(() => { rmSync(e.root, { recursive: true, force: true }) })

  function expectAutoPositive(id: string, commitmentBefore: unknown) {
    const after = engrams(e).find(x => x.id === id)!
    expect(after.feedback_signals?.positive).toBe(1)
    expect(after.commitment).toBe(commitmentBefore)
    const ev = history(e).find(h => h.event === 'feedback_received' && h.engram_id === id)
    expect(ev?.data).toMatchObject({ signal: 'positive', source: 'auto' })
  }

  it('Claude Code: UserPromptSubmit inject, then Stop with last_assistant_message', () => {
    const id = seed(e)
    const commitment = engrams(e).find(x => x.id === id)!.commitment
    const inj = cli(e, ['hook-inject'], { hook_event_name: 'UserPromptSubmit', session_id: 'cc-1', prompt: 'deploy the invoice service after the zebra-quartz migration' })
    expect(inj.stdout, inj.stderr).toContain('zebra-quartz')
    const stop = cli(e, ['hook-auto-rate', 'claude'], { hook_event_name: 'Stop', session_id: 'cc-1', cwd: e.project, stop_hook_active: false, last_assistant_message: QUOTING_REPLY })
    expect(stop.status).toBe(0)
    expect(stop.stdout).toBe('')
    expectAutoPositive(id, commitment)
  })

  it('Codex: UserPromptSubmit inject, then Stop with last_assistant_message', () => {
    const id = seed(e)
    const commitment = engrams(e).find(x => x.id === id)!.commitment
    const inj = cli(e, ['hook-codex-inject'], { hook_event_name: 'UserPromptSubmit', session_id: 'cx-1', cwd: e.project, prompt: 'deploy the invoice service after the zebra-quartz migration' }, { PLUR_HOOK_NO_EXIT: '' })
    expect(inj.stdout, inj.stderr).toContain('zebra-quartz')
    const stop = cli(e, ['hook-auto-rate', 'codex'], { hook_event_name: 'Stop', session_id: 'cx-1', cwd: e.project, stop_hook_active: false, last_assistant_message: QUOTING_REPLY })
    expect(stop.stdout).toBe('')
    expectAutoPositive(id, commitment)
  })

  it('Cursor: sessionStart inject, then afterAgentResponse with text', () => {
    // Cursor's sessionStart has no prompt: it recalls for "general session
    // start", so the engram has to be about that to be injected at all.
    const statement = 'At general session start, check the zebra-quartz migration status first'
    const id = seed(e, statement)
    const commitment = engrams(e).find(x => x.id === id)!.commitment
    cli(e, ['hook-cursor-session-start'], { conversation_id: 'cu-1' })
    const stop = cli(e, ['hook-auto-rate', 'cursor'], { conversation_id: 'cu-1', generation_id: 'g', text: `Sure. ${statement}. It is clean.` })
    expect(stop.stdout).toBe('')
    expectAutoPositive(id, commitment)
  })

  it('Antigravity: PreInvocation inject, then Stop with the reply read from the transcript', () => {
    const id = seed(e)
    const commitment = engrams(e).find(x => x.id === id)!.commitment
    const transcript = join(e.root, 'transcript.jsonl')
    writeFileSync(transcript, [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\ndeploy the invoice service after the zebra-quartz migration\n</USER_REQUEST>' }),
    ].join('\n') + '\n')
    const base = { conversationId: 'ag-1', transcriptPath: transcript, workspacePaths: [e.project] }
    const inj = cli(e, ['hook-agy-pre-invocation'], { ...base, invocationNum: 0 })
    expect(inj.stdout, inj.stderr).toContain('zebra-quartz')
    writeFileSync(transcript, readFileSync(transcript, 'utf8') +
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: QUOTING_REPLY }) + '\n')
    const stop = cli(e, ['hook-auto-rate', 'agy'], { ...base, executionNum: 1, terminationReason: 'model_stop' })
    expect(stop.stdout).toBe('')
    expectAutoPositive(id, commitment)
  })

  it('rates each injected engram at most once per session', () => {
    const id = seed(e)
    cli(e, ['hook-inject'], { hook_event_name: 'UserPromptSubmit', session_id: 'cc-2', prompt: 'zebra-quartz migration invoice service' })
    const stopPayload = { hook_event_name: 'Stop', session_id: 'cc-2', cwd: e.project, last_assistant_message: QUOTING_REPLY }
    cli(e, ['hook-auto-rate', 'claude'], stopPayload)
    cli(e, ['hook-auto-rate', 'claude'], stopPayload)
    expect(engrams(e).find(x => x.id === id)!.feedback_signals?.positive).toBe(1)
  })

  it('writes nothing when nothing was injected this session', () => {
    const id = seed(e)
    const before = readFileSync(join(e.plurPath, 'engrams.yaml'), 'utf8')
    const stop = cli(e, ['hook-auto-rate', 'claude'], { hook_event_name: 'Stop', session_id: 'never-injected', cwd: e.project, last_assistant_message: QUOTING_REPLY })
    expect(stop.status).toBe(0)
    expect(readFileSync(join(e.plurPath, 'engrams.yaml'), 'utf8')).toBe(before)
    expect(engrams(e).find(x => x.id === id)!.feedback_signals?.positive ?? 0).toBe(0)
  })

  it('PLUR_AUTO_RATE=0 turns it off', () => {
    const id = seed(e)
    cli(e, ['hook-inject'], { hook_event_name: 'UserPromptSubmit', session_id: 'cc-3', prompt: 'zebra-quartz migration invoice service' }, { PLUR_AUTO_RATE: '0' })
    cli(e, ['hook-auto-rate', 'claude'], { hook_event_name: 'Stop', session_id: 'cc-3', cwd: e.project, last_assistant_message: QUOTING_REPLY }, { PLUR_AUTO_RATE: '0' })
    expect(engrams(e).find(x => x.id === id)!.feedback_signals?.positive ?? 0).toBe(0)
  })

  describe('auto-capture', () => {
    const LEARNING_REPLY = 'Done.\n\n---\n🧠 I learned:\n- The staging cluster rejects deploys on Fridays after noon\n---\n'

    it('writes nothing unless PLUR_AUTO_CAPTURE opts in', () => {
      seed(e)
      const count = engrams(e).length
      cli(e, ['hook-auto-rate', 'claude'], { hook_event_name: 'Stop', session_id: 'cap-1', cwd: e.project, last_assistant_message: LEARNING_REPLY })
      expect(engrams(e).length).toBe(count)
      expect(engrams(e).some(x => /staging cluster/.test(x.statement))).toBe(false)
    })

    it('with PLUR_AUTO_CAPTURE=1, stores the self-reported learning as inferred', () => {
      seed(e)
      cli(e, ['hook-auto-rate', 'claude'], { hook_event_name: 'Stop', session_id: 'cap-2', cwd: e.project, last_assistant_message: LEARNING_REPLY }, { PLUR_AUTO_CAPTURE: '1' })
      const captured = engrams(e).find(x => /staging cluster rejects deploys/.test(x.statement))
      expect(captured).toBeTruthy()
    })
  })
})
