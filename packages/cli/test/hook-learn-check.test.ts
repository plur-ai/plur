import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, symlinkSync, appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * The spawn env starts from the runner's, minus every variable that changes
 * this hook's behaviour (review F5): a runner with PLUR_PATH exported would get
 * checkpoints written into its real store, and one with
 * PLUR_LEARN_FALLBACK_INTERVAL exported would break the default-interval tests.
 * Tests set what they need explicitly on top.
 */
const HOOK_ENV_VARS = ['PLUR_PATH', 'PLUR_LEARN_FALLBACK_INTERVAL', 'PLUR_CHECKPOINT_INTERVAL', 'CLAUDE_SESSION_ID']
function cleanEnv(over: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of HOOK_ENV_VARS) delete env[k]
  return { ...env, ...over }
}

describe('hook-learn-check', () => {
  let home: string
  let tmp: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-learn-check-home-'))
    tmp = join(home, 'tmp')
    mkdirSync(tmp, { recursive: true })
    // Mark the project as plur-configured so the hook doesn't silently no-op (#247).
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { plur: { command: '/bin/sh', args: [] } } }),
    )
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // The interval-shape tests below pin the no-signal fallback to every 3rd
  // Stop so they stay short; the default (10) has its own test.
  function runHook(sessionId: string, cwd: string = home, extraEnv: Record<string, string> = { PLUR_LEARN_FALLBACK_INTERVAL: '3' }): { stdout: string; status: number } {
    const result = runCli('node', [CLI, 'hook-learn-check'], {
      input: JSON.stringify({ cwd }),
      encoding: 'utf-8',
      timeout: 10000,
      env: cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_SESSION_ID: sessionId, ...extraEnv }),
      cwd: home,
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  /**
   * Drive the hook the way Claude Code does (#1266): the session id arrives in
   * the stdin payload, CLAUDE_SESSION_ID is NOT set, and the hook is launched
   * through a shell — so process.ppid is a fresh `sh` pid on every Stop.
   */
  function runStop(payload: Record<string, unknown>, extraEnv: Record<string, string> = { PLUR_LEARN_FALLBACK_INTERVAL: '3' }): { stdout: string; status: number } {
    const env = cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: tmp, ...extraEnv })
    const result = runCli('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" hook-learn-check`], {
      input: JSON.stringify({ cwd: home, hook_event_name: 'Stop', ...payload }),
      encoding: 'utf-8',
      timeout: 10000,
      env,
      cwd: home,
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  /** The Stop-event delivery shape Claude Code actually hands to the model. */
  function nudgeText(stdout: string): string | undefined {
    try {
      const out = JSON.parse(stdout)
      if (out?.hookSpecificOutput?.hookEventName !== 'Stop') return undefined
      const ctx = out.hookSpecificOutput.additionalContext
      return typeof ctx === 'string' ? ctx : undefined
    } catch {
      return undefined
    }
  }

  it('prints nothing when plur is not configured', () => {
    const bareHome = mkdtempSync(join(tmpdir(), 'plur-learn-check-bare-'))
    const bareTmp = join(bareHome, 'tmp')
    mkdirSync(bareTmp, { recursive: true })
    try {
      const result = runCli('node', [CLI, 'hook-learn-check'], {
        input: JSON.stringify({ cwd: bareHome }),
        encoding: 'utf-8',
        timeout: 10000,
        env: cleanEnv({ HOME: bareHome, USERPROFILE: bareHome, TMPDIR: bareTmp, CLAUDE_SESSION_ID: 'unconfigured' }),
        cwd: bareHome,
      })
      // #1266: a Stop hook's stdout is parsed as hook OUTPUT — echoing the
      // input payload back was at best ignored. Say nothing.
      expect(result.stdout).toBe('')
    } finally {
      rmSync(bareHome, { recursive: true, force: true })
    }
  })

  it('with no signal, stays silent on the 1st and 2nd stop, nudges on the fallback interval (3 here)', () => {
    const id = 'learn-interval-test'
    expect(runHook(id).stdout).toBe('')
    expect(runHook(id).stdout).toBe('')
    const third = runHook(id)
    expect(nudgeText(third.stdout)).toContain('plur_learn')
  })

  // #1266: Claude Code ignores a Stop hook's TOP-LEVEL additionalContext
  // (recorded as plain hook stdout, never shown to the model). Only the
  // hookSpecificOutput form is delivered — verified in a real session.
  it('delivers the nudge as hookSpecificOutput for the Stop event, not top-level', () => {
    const id = 'shape-test'
    runHook(id)
    runHook(id)
    const out = JSON.parse(runHook(id).stdout)
    expect(out).not.toHaveProperty('additionalContext')
    expect(out.hookSpecificOutput.hookEventName).toBe('Stop')
    expect(out.hookSpecificOutput.additionalContext).toContain('plur_learn')
  })

  // #1266: the delivered form forces ONE continuation turn. That turn ends in
  // another Stop with stop_hook_active: true — nudging there would loop.
  it('never nudges when stop_hook_active is true', () => {
    const session_id = '5e0c1f7a-0000-4000-8000-000000000001'
    runStop({ session_id })
    runStop({ session_id })
    // The 3rd Stop is a continuation Stop: must stay silent.
    expect(runStop({ session_id, stop_hook_active: true }).stdout).toBe('')
    // ...and it does not consume the interval — the next real Stop nudges.
    expect(nudgeText(runStop({ session_id }).stdout)).toContain('plur_learn')
    // The continuation that nudge forces must not nudge again.
    expect(runStop({ session_id, stop_hook_active: true }).stdout).toBe('')
  })

  // #1266: Claude Code puts the session id in the payload and does not export
  // CLAUDE_SESSION_ID to hooks. Keyed on ppid, each Stop (a fresh shell) got a
  // fresh counter and the every-3rd nudge could never fire.
  it('keys the counter on the payload session_id, across different ppids', () => {
    const session_id = '5e0c1f7a-0000-4000-8000-000000000002'
    expect(runStop({ session_id }).stdout).toBe('')
    expect(runStop({ session_id }).stdout).toBe('')
    expect(nudgeText(runStop({ session_id }).stdout)).toContain('plur_learn')
    // A different session keeps its own count.
    expect(runStop({ session_id: '5e0c1f7a-0000-4000-8000-000000000003' }).stdout).toBe('')
  })

  it('writes the checkpoint under the payload session_id', () => {
    const session_id = '5e0c1f7a-0000-4000-8000-000000000004'
    for (let i = 0; i < 10; i++) runStop({ session_id })
    const checkpointPath = join(home, '.plur', 'sessions', `${session_id}.checkpoint.json`)
    expect(existsSync(checkpointPath)).toBe(true)
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).session_id).toBe(session_id)
  })

  it('sanitises a hostile payload session_id before using it as a path', () => {
    const session_id = '../../escape'
    for (let i = 0; i < 10; i++) runStop({ session_id })
    expect(existsSync(join(home, '.plur', 'escape.checkpoint.json'))).toBe(false)
    expect(existsSync(join(home, '.plur', 'sessions', '______escape.checkpoint.json'))).toBe(true)
  })

  it('writes a session checkpoint on the 10th stop (CHECKPOINT_INTERVAL)', () => {
    const id = 'checkpoint-test'
    for (let i = 0; i < 9; i++) runHook(id)
    const checkpointPath = join(home, '.plur', 'sessions', `${id}.checkpoint.json`)
    expect(existsSync(checkpointPath)).toBe(false)

    runHook(id) // 10th call
    expect(existsSync(checkpointPath)).toBe(true)
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
    expect(checkpoint.stop_count).toBe(10)
    expect(checkpoint.session_id).toBe(id)
  })

  // Audit fix, 2026-07-09 (cross-referenced from feat/cursor-integration's
  // evaluator review): the counter used to be read-int/increment/write,
  // which can lose an increment if two Stop hook processes fire close
  // together (each invocation is a fresh, independent process). This
  // doesn't reproduce true concurrency (that would be flaky-by-nature to
  // assert on), but locks in that N sequential calls advance the counter
  // by exactly N — the invariant the atomic-append fix must preserve.
  it('advances the counter by exactly one per sequential call', () => {
    const id = 'sequential-count-test'
    // 3rd, 6th, 9th, 12th stops nudge; count is otherwise only observable
    // indirectly, so drive it to the 30th stop and confirm a checkpoint
    // (10th) and nudges land on the expected boundaries, not off-by-one.
    const results: string[] = []
    for (let i = 1; i <= 12; i++) {
      const { stdout } = runHook(id)
      results.push(stdout)
    }
    const nudged = results.map((r) => {
      return nudgeText(r) !== undefined
    })
    expect(nudged).toEqual([
      false, false, true, // 1,2,3
      false, false, true, // 4,5,6
      false, false, true, // 7,8,9
      false, false, true, // 10,11,12
    ])
  })

  // MISSING (fail-open contract, PROVEN): a Stop hook MUST never throw — it is on
  // the hot path of every response. But counterPath()'s mkdir/appendFileSync of
  // $TMPDIR/plur-sessions is not wrapped in try/catch, so an unwritable $TMPDIR
  // makes the hook EXIT 1 and print {"error":...} to stdout (index.ts's top-level
  // catch). Correct behaviour: exit 0 and emit valid/empty output. it.fails until
  // the counter I/O is made fail-open; flip to it() when green.
  it('never crashes the response when the state dir is unwritable', () => {
    const roTmp = mkdtempSync(join(tmpdir(), 'plur-ro-learn-'))
    chmodSync(roTmp, 0o500) // r-x: owner cannot create plur-sessions inside
    try {
      const result = runCli('node', [CLI, 'hook-learn-check'], {
        input: JSON.stringify({ cwd: home }),
        encoding: 'utf-8',
        timeout: 10000,
        env: cleanEnv({ HOME: home, USERPROFILE: home, TMPDIR: roTmp, CLAUDE_SESSION_ID: 'ro-learn' }),
        cwd: home,
      })
      expect(result.status ?? 1).toBe(0) // fail-open: never a non-zero exit
      expect(result.stdout ?? '').not.toContain('"error"')
    } finally {
      chmodSync(roTmp, 0o700)
      rmSync(roTmp, { recursive: true, force: true })
    }
  })

  // ── Signal-based nudge (gentler memory check, 2026-10-01) ──────────────────
  // The nudge forces one extra model turn, which used to end in a bare "ok"
  // every 3rd response. It now fires when the user's last message carries a
  // correction / preference / decision signal, plus a rare fallback.

  function writeTranscript(name: string, userText: string, uuid = `u-${name}`): string {
    const path = join(home, `${name}.jsonl`)
    const lines = [
      { type: 'user', uuid: 'earlier', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'user', uuid, message: { role: 'user', content: userText } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return path
  }

  it('nudges on the first Stop when the last user message is a correction', () => {
    const transcript_path = writeTranscript('corr', "no, don't use npm here — use pnpm")
    const text = nudgeText(runStop({ session_id: 'sig-1', transcript_path }, {}).stdout)
    expect(text).toContain('plur_learn')
  })

  it('nudges for a decision-board answer (a saved .decisions.json path)', () => {
    const transcript_path = writeTranscript('board', 'Saved: /tmp/review.decisions.json')
    expect(nudgeText(runStop({ session_id: 'sig-2', transcript_path }, {}).stdout)).toContain('plur_learn')
  })

  it('stays silent for a plain question (default fallback, well below 20 stops)', () => {
    const transcript_path = writeTranscript('plain', 'what does this function return?')
    for (let i = 0; i < 5; i++) {
      expect(runStop({ session_id: 'plain-1', transcript_path }, {}).stdout).toBe('')
    }
  })

  it('nudges once per signalling message, not on every later Stop that still sees it', () => {
    // A background-task notification can end another turn without a new
    // human message; the same correction must not nudge twice.
    const transcript_path = writeTranscript('once', 'from now on keep PRs small', 'same-msg')
    expect(nudgeText(runStop({ session_id: 'once-1', transcript_path }, {}).stdout)).toContain('plur_learn')
    expect(runStop({ session_id: 'once-1', transcript_path }, {}).stdout).toBe('')
    // A new signalling message nudges again.
    const next = writeTranscript('once', 'actually, I prefer squash merges', 'next-msg')
    expect(nudgeText(runStop({ session_id: 'once-1', transcript_path: next }, {}).stdout)).toContain('plur_learn')
  })

  it('never nudges on a continuation Stop, even when the message signals', () => {
    const transcript_path = writeTranscript('cont', 'never print the token')
    expect(runStop({ session_id: 'cont-1', transcript_path, stop_hook_active: true }, {}).stdout).toBe('')
  })

  /** Pre-seed the Stop counter so a test reaches Stop N in one spawn (review F5). */
  function seedCounter(sessionId: string, stops: number): void {
    const dir = join(tmp, 'plur-sessions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (let i = 0; i < stops; i++) appendFileSync(join(dir, `${sessionId}.stop-count`), `seed-${i}\n`)
  }

  it('the fallback fires on the 10th signal-free Stop by default', () => {
    const transcript_path = writeTranscript('fb', 'please summarise the changelog')
    seedCounter('fb-1', 8)
    expect(runStop({ session_id: 'fb-1', transcript_path }, {}).stdout).toBe('') // 9th
    expect(nudgeText(runStop({ session_id: 'fb-1', transcript_path }, {}).stdout)).toContain('plur_learn') // 10th
  })

  it('PLUR_LEARN_FALLBACK_INTERVAL=0 turns the fallback off (signals still nudge)', () => {
    for (let i = 0; i < 4; i++) {
      expect(runStop({ session_id: 'off-1' }, { PLUR_LEARN_FALLBACK_INTERVAL: '0' }).stdout).toBe('')
    }
    const transcript_path = writeTranscript('off', 'always run the typecheck')
    expect(nudgeText(runStop({ session_id: 'off-1', transcript_path }, { PLUR_LEARN_FALLBACK_INTERVAL: '0' }).stdout)).toContain('plur_learn')
  })

  it('a missing or unreadable transcript falls back to the interval and never fails the Stop', () => {
    const dirAsFile = join(home, 'a-directory')
    mkdirSync(dirAsFile)
    const results = [
      runStop({ session_id: 'miss-1', transcript_path: join(home, 'nope.jsonl') }),
      runStop({ session_id: 'miss-1', transcript_path: dirAsFile }),
      runStop({ session_id: 'miss-1', transcript_path: 12345 }),
    ]
    for (const r of results) expect(r.status).toBe(0)
    expect(results.map((r) => nudgeText(r.stdout) !== undefined)).toEqual([false, false, true])
  })

  // ── 0.21.1 review round (F4–F8) ───────────────────────────────────────────

  // F7: #1520 has the agent end every reply with a memory line. The forced
  // turn must not ask for a bare "ok" on top of it.
  it('the nudge text is compatible with the per-reply memory line', () => {
    const transcript_path = writeTranscript('f7', 'from now on keep PRs small')
    const signal = nudgeText(runStop({ session_id: 'f7-1', transcript_path }, {}).stdout) ?? ''
    seedCounter('f7-2', 9)
    const fallback = nudgeText(runStop({ session_id: 'f7-2' }, {}).stdout) ?? ''
    for (const text of [signal, fallback]) {
      expect(text).toContain('plur_learn')
      expect(text).not.toMatch(/reply with just/i)
      expect(text).toMatch(/memory line/i)
    }
  })

  // F4: the agent already saved it in that reply — no second turn for it.
  function writeLearnedTranscript(name: string, userText: string): string {
    const path = join(home, `${name}.jsonl`)
    const lines = [
      { type: 'user', uuid: `u-${name}`, message: { role: 'user', content: userText } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__plur__plur_learn', input: { statement: 'x' } }] } },
      { type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'saved' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'saved it' }] } },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return path
  }

  it('does not nudge when plur_learn was already called in that reply (signal or fallback)', () => {
    const transcript_path = writeLearnedTranscript('f4', 'no, use pnpm not npm')
    expect(runStop({ session_id: 'f4-1', transcript_path }, {}).stdout).toBe('')
    expect(runStop({ session_id: 'f4-2', transcript_path }, { PLUR_LEARN_FALLBACK_INTERVAL: '1' }).stdout).toBe('')
  })

  // F5: the runner's own PLUR_PATH / PLUR_LEARN_FALLBACK_INTERVAL never reach the hook.
  it('the spawned hook does not inherit the runner\'s PLUR_PATH or fallback interval', () => {
    const leak = join(home, 'runner-store')
    const saved = { PLUR_PATH: process.env.PLUR_PATH, PLUR_LEARN_FALLBACK_INTERVAL: process.env.PLUR_LEARN_FALLBACK_INTERVAL }
    process.env.PLUR_PATH = leak
    process.env.PLUR_LEARN_FALLBACK_INTERVAL = '1'
    try {
      const transcript_path = writeTranscript('f5', 'please summarise the changelog')
      const r = runStop({ session_id: 'f5-1', transcript_path }, { PLUR_CHECKPOINT_INTERVAL: '1' })
      expect(r.stdout).toBe('') // default interval, 1st Stop: silent
      expect(existsSync(leak)).toBe(false)
      expect(existsSync(join(home, '.plur', 'sessions', 'f5-1.checkpoint.json'))).toBe(true)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  // F6: the marker is never written through a symlink.
  it.skipIf(process.platform === 'win32')('never writes the nudge marker through a planted symlink', () => {
    const dir = join(tmp, 'plur-sessions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const target = join(home, 'precious.txt')
    writeFileSync(target, 'precious')
    symlinkSync(target, join(dir, 'f6-sym.learn-nudged')) // the marker name b340d2dd used
    const transcript_path = writeTranscript('f6s', 'from now on keep PRs small')
    expect(runStop({ session_id: 'f6-sym', transcript_path }, {}).status).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  // F6: a marker that cannot be written means "do not nudge", not "nudge every Stop".
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('does not nudge repeatedly when the marker cannot be written', () => {
    const dir = join(tmp, 'plur-sessions')
    expect(runStop({ session_id: 'f6-ro' }, { PLUR_LEARN_FALLBACK_INTERVAL: '0' }).stdout).toBe('') // creates dir + counter
    chmodSync(dir, 0o500) // the counter file stays appendable; no new file can be created
    try {
      const transcript_path = writeTranscript('f6r', 'from now on keep PRs small')
      const nudges = [0, 1, 2].filter(() => nudgeText(runStop({ session_id: 'f6-ro', transcript_path }, { PLUR_LEARN_FALLBACK_INTERVAL: '0' }).stdout) !== undefined)
      expect(nudges.length).toBe(0)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  // F8: a FIFO (or any non-regular file) as transcript_path must not block the Stop.
  it.skipIf(process.platform === 'win32')('never blocks on a FIFO transcript path', () => {
    const fifo = join(home, 'transcript.fifo')
    execFileSync('mkfifo', [fifo])
    const started = Date.now()
    const r = runStop({ session_id: 'f8-1', transcript_path: fifo }, { PLUR_LEARN_FALLBACK_INTERVAL: '1' })
    expect(r.status).toBe(0)
    expect(nudgeText(r.stdout)).toContain('plur_learn') // no message → only the fallback
    expect(Date.now() - started).toBeLessThan(8000)
  })

  // ── 0.21.1 re-audit (R3, R5) ──────────────────────────────────────────────

  // R3: one nudge per user message at most. A signal nudge on Stop 9, then a
  // background task ends the turn again on Stop 10 (the fallback count) with
  // the same last message: no second nudge for it.
  it('the fallback never nudges again for a message that already got a signal nudge', () => {
    const transcript_path = writeTranscript('r3', 'No, use pnpm.')
    seedCounter('r3-1', 8)
    expect(nudgeText(runStop({ session_id: 'r3-1', transcript_path }, {}).stdout)).toContain('plur_learn') // 9th: signal
    expect(runStop({ session_id: 'r3-1', transcript_path }, {}).stdout).toBe('') // 10th: fallback count, same message
  })

  // R5: the checkpoint read never blocks on a FIFO planted at its path.
  it.skipIf(process.platform === 'win32')('never blocks on a FIFO at the checkpoint path', () => {
    const store = join(home, 'store')
    mkdirSync(join(store, 'sessions'), { recursive: true, mode: 0o700 })
    execFileSync('mkfifo', [join(store, 'sessions', 'r5-1.checkpoint.json')])
    const started = Date.now()
    const r = runStop({ session_id: 'r5-1' }, { PLUR_PATH: store, PLUR_CHECKPOINT_INTERVAL: '1', PLUR_LEARN_FALLBACK_INTERVAL: '0' })
    expect(r.status).toBe(0)
    expect(Date.now() - started).toBeLessThan(8000)
  })
})
