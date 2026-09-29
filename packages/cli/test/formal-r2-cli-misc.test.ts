import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { hookHarnesses, readyLine } from '../src/commands/doctor.js'

/**
 * Formal round 2 — cli#10 (doctor false green), cli#12 (Antigravity turn
 * cache), and the `--` follow-up for free-text commands.
 * spec/formal/PlurSpec/R2CLI.lean §5–§7, findings/r2-cli.md items 5–7.
 */

const CLI = process.env.PLUR_R2_CLI ?? builtCliPath(join(__dirname, '..'))
const posixOnly = process.platform === 'win32' ? it.skip : it

describe('cli#10 doctor verdict names only harnesses with hooks', () => {
  const cfg = (label: string, hasPlurHooks: boolean) => ({ label, hasPlurHooks })

  it('Codex-only hooks never claim Claude Code is ready', () => {
    const h = hookHarnesses([cfg('Claude Code (global)', false), cfg('Codex (~/.codex/hooks.json)', true)])
    expect(h).toEqual(['Codex'])
    expect(readyLine(h)).not.toContain('ready to use in Claude Code')
    expect(readyLine(h)).toContain('Codex')
  })

  it('Claude Code hooks keep the original line', () => {
    const h = hookHarnesses([cfg('Claude Code (project)', true), cfg('Claude Code (global)', true), cfg('Cursor (.cursor/hooks.json)', true)])
    expect(h).toEqual(['Claude Code', 'Cursor'])
    expect(readyLine(h)).toBe('✓ Healthy. plur is ready to use in Claude Code.')
  })
})

describe('`--` makes the next token data, not a flag', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-r2-dd-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const cli = (...args: string[]) => runCli('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, PLUR_PATH: join(home, '.plur'), PLUR_DISABLE_EMBEDDINGS: '1', TMPDIR: home },
  })

  it('capture -- "-x" stores "-x", not "--"', () => {
    const r = cli('--json', 'capture', '--', '-starts with a dash')
    expect(JSON.parse(r.stdout).summary).toBe('-starts with a dash')
  }, 60_000)

  it('recall -- "-x" searches for "-x"', () => {
    cli('--json', 'learn', '--', '-dash statement for recall')
    const r = cli('--json', '--fast', 'recall', '--', '-dash statement')
    expect(JSON.parse(r.stdout).count).toBe(1)
  }, 60_000)
})

describe('cli#12 Antigravity turn identity', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-r2-agy-'))
    mkdirSync(join(root, 'tmp'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const hook = (payload: object) => runCli('node', [CLI, 'hook-agy-pre-invocation'], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: root,
      TMPDIR: join(root, 'tmp'),
      PLUR_PATH: join(root, '.plur'),
      PLUR_HOOK_NO_EXIT: '1',
      PLUR_DISABLE_EMBEDDINGS: '1',
      PLUR_HOOK_HYBRID: '0',
    },
  })

  it('an identical message re-sent without step_index is a NEW turn (recall runs again)', () => {
    const t = join(root, 't.jsonl')
    writeFileSync(t, '{"type":"USER_INPUT","content":"<USER_REQUEST>yes</USER_REQUEST>"}\n')
    hook({ conversationId: 'a1', invocationNum: 0, transcriptPath: t })
    // A mid-turn invocation of the SAME turn must not re-recall…
    hook({ conversationId: 'a1', invocationNum: 1, transcriptPath: t })
    const turncount = join(root, 'tmp', 'plur-agy-sessions', 'a1.turncount')
    expect(readFileSync(turncount, 'utf8').trim()).toBe('1')
    // …but the user saying "yes" again is a new turn.
    appendFileSync(t, '{"type":"PLANNER_RESPONSE","content":"ok"}\n{"type":"USER_INPUT","content":"<USER_REQUEST>yes</USER_REQUEST>"}\n')
    hook({ conversationId: 'a1', invocationNum: 0, transcriptPath: t })
    expect(readFileSync(turncount, 'utf8').trim()).toBe('2')
  }, 60_000)

  posixOnly('an unusable cache dir does not make every turn the session start', () => {
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'tmp', 'plur-agy-sessions'))
    const t = join(root, 't2.jsonl')
    writeFileSync(t,
      '{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>one</USER_REQUEST>"}\n' +
      '{"step_index":3,"type":"USER_INPUT","content":"<USER_REQUEST>two</USER_REQUEST>"}\n')
    const r = hook({ conversationId: 'b1', invocationNum: 0, transcriptPath: t })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('session started')
  }, 60_000)

  it('the genuine first turn still gets the session-start header', () => {
    const t = join(root, 't3.jsonl')
    writeFileSync(t, '{"step_index":0,"type":"USER_INPUT","content":"<USER_REQUEST>hello</USER_REQUEST>"}\n')
    const r = hook({ conversationId: 'c1', invocationNum: 0, transcriptPath: t })
    expect(r.stdout).toContain('session started')
  }, 60_000)
})
