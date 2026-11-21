/**
 * H14: an event injection (skill, agent, plan mode, subagent) records why it
 * took the leg it took and what it got, in hook-runs.json
 * (`notes.claude.event`): the event, the planner's reason, the leg, the true
 * mode of the result (a hybrid result can come back `hybrid-degraded`), the
 * degraded reason and the embedder error. A hybrid search that fails after
 * losing the race to the keyword fallback is no longer dropped: its message
 * reaches the caller and the record. Nothing more is printed to the prompt.
 *
 * Temp HOME / PLUR_PATH / TMPDIR only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { injectWithFallback, effectiveInjectMode } from '../src/lib/codex-hook-io.js'
import { readHookNotes } from '../src/lib/hook-runs.js'

const CLI = builtCliPath(join(__dirname, '..'))
let scratch: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const d of scratch) rmSync(d, { recursive: true, force: true }); scratch = [] })

describe('injectWithFallback: hybrid failures reach the caller (H14)', () => {
  const R = (count: number, extra: Record<string, unknown> = {}) => ({ directives: '', constraints: '', consider: '', count, ...extra })

  it('a hybrid search that rejects after missing the deadline reports its message as a late failure', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const seen: Array<[string, string]> = []
    let rejectLate!: (e: Error) => void
    const plur = {
      injectHybrid: () => new Promise<ReturnType<typeof R>>((_r, rej) => { rejectLate = rej }),
      inject: async () => R(3),
    }
    const out = await injectWithFallback(plur, 'q', {}, 20, { onHybridError: (message, phase) => { seen.push([message, phase]) } })
    expect(out.mode).toBe('bm25')
    rejectLate(new Error('embedder crashed late'))
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual([['embedder crashed late', 'late']])
  })

  it('an immediate hybrid failure is reported as failed', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const seen: Array<[string, string]> = []
    const plur = { injectHybrid: async () => { throw new Error('embedder unavailable') }, inject: async () => R(2) }
    await injectWithFallback(plur, 'q', {}, 1000, { onHybridError: (message, phase) => { seen.push([message, phase]) } })
    expect(seen).toEqual([['embedder unavailable', 'failed']])
  })

  it('the true mode: a hybrid leg whose result is degraded is hybrid-degraded, not hybrid', () => {
    expect(effectiveInjectMode({ mode: 'hybrid', result: R(1, { mode: 'hybrid-degraded' }) })).toBe('hybrid-degraded')
    expect(effectiveInjectMode({ mode: 'hybrid', result: R(1, { mode: 'hybrid' }) })).toBe('hybrid')
    expect(effectiveInjectMode({ mode: 'hybrid', result: R(1) })).toBe('hybrid')
    expect(effectiveInjectMode({ mode: 'bm25', result: R(1, { mode: 'hybrid' }) })).toBe('bm25')
  })
})

function runHook(args: string[], input: object, env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(JSON.stringify(input))
  })
}

describe('spawned event hook records its retrieval plan (H14)', () => {
  it('a skill event on a cold cache records event, reason, leg and mode in hook-runs.json and prints only the context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-event-diag-')); scratch.push(dir)
    const store = join(dir, '.plur')
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    const plur = new Plur({ path: store })
    await plur.learn('codeword zephyr-quartz applies to planning skills agents and subagents', { scope: 'global', type: 'behavioral' })
    plur.close?.()
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1' }
    delete env.PLUR_HOOK_HYBRID
    delete env.CLAUDE_SESSION_ID
    const r = await runHook([CLI, 'hook-inject', '--event', 'skill'],
      { cwd: dir, session_id: 'diag-1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' } }, env, dir)
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    expect(out.hookSpecificOutput.additionalContext).toContain('zephyr-quartz')
    const note = readHookNotes(store).claude?.event
    expect(note, JSON.stringify(readHookNotes(store))).toBeDefined()
    expect(note).toMatchObject({ event: 'skill', leg: 'keyword', mode: 'bm25' })
    expect(typeof note!.reason).toBe('string')
    expect(['hybrid-off', 'cache-cold']).toContain(note!.reason)
  }, 60_000)
})
