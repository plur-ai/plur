import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { run } from '../src/commands/hook-agy-pre-invocation.js'
import {
  agySentinelPath,
  agyCounterPath,
  readAgyTurnCache,
  writeAgyTurnCache,
  agyTextHash,
} from '../src/lib/agy-hook-io.js'

/**
 * Command-level tests for the agy injection hook — the most stateful code in
 * either adapter (evaluator audit M15 flagged it as having zero coverage).
 * Injection itself is stubbed: what is under test is the TURN-CACHE state
 * machine — when recall runs, when the cached message replays, and when
 * nothing is emitted — because that is where all three audits found bugs
 * (M5 empty-message re-recall, M6/F4 step freezes, F9 id collisions, B1
 * scope loss).
 */

const SID = 'agy-preinv-test-conversation'

process.env.PLUR_HOOK_NO_EXIT = '1'

// ── stubs ───────────────────────────────────────────────────────────────────

let injectCalls: Array<{ task: string; opts: Record<string, unknown> }>
let injectResult: { count: number; directives: string; constraints: string; consider: string }
let projectConfigCalls: string[]
let stubbedScope: string | undefined

vi.mock('../src/lib/codex-hook-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/codex-hook-io.js')>()
  return {
    ...actual,
    readStdinJson: () => (globalThis as Record<string, unknown>).__plurAgyStdin ?? {},
    injectWithFallback: async (_plur: unknown, task: string, opts: Record<string, unknown>) => {
      injectCalls.push({ task, opts })
      return { result: injectResult, mode: 'hybrid' }
    },
  }
})

vi.mock('../src/plur.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plur.js')>()
  return { ...actual, createPlur: () => ({}) as never }
})

vi.mock('@plur-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plur-ai/core')>()
  return {
    ...actual,
    readProjectConfig: (startDir?: string) => {
      projectConfigCalls.push(startDir ?? '(default)')
      return stubbedScope ? { scope: stubbedScope } : {}
    },
  }
})

function setStdin(payload: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).__plurAgyStdin = payload
}

// ── fixtures ────────────────────────────────────────────────────────────────

let dir: string
let written: string[]
let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

function transcript(...turns: Array<{ step: number; text: string }>): string {
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, turns.map(t => JSON.stringify({
    step_index: t.step, type: 'USER_INPUT', content: `<USER_REQUEST>\n${t.text}\n</USER_REQUEST>`,
  })).join('\n'))
  return p
}

function emittedMessage(): string | null {
  const last = written.at(-1)
  if (!last) return null
  const parsed = JSON.parse(last) as { injectSteps?: Array<{ ephemeralMessage?: string }> }
  return parsed.injectSteps?.[0]?.ephemeralMessage ?? null
}

function clean() {
  for (const n of ['turncache', 'turncount', 'guard-count']) rmSync(agyCounterPath(SID, n), { force: true })
  rmSync(agySentinelPath(SID), { force: true })
}

beforeEach(() => {
  clean()
  dir = mkdtempSync(join(tmpdir(), 'plur-agy-preinv-'))
  written = []
  injectCalls = []
  projectConfigCalls = []
  stubbedScope = undefined
  injectResult = { count: 2, directives: 'DIRECTIVE-LINE', constraints: '', consider: '' }
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    if (String(c).length > 0) written.push(String(c))
    return true
  }) as never)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  stdout.mockRestore()
  stderr.mockRestore()
  rmSync(dir, { recursive: true, force: true })
  clean()
})

// ── the state machine ───────────────────────────────────────────────────────

describe('hook-agy-pre-invocation', () => {
  it('first turn: recalls once, emits, and caches the rendered message', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: transcript({ step: 0, text: 'first question' }) })
    await run([], {} as never)

    expect(injectCalls).toHaveLength(1)
    expect(injectCalls[0].task).toBe('first question')
    expect(emittedMessage()).toContain('DIRECTIVE-LINE')

    const cache = readAgyTurnCache(SID)
    expect(cache?.message).toContain('DIRECTIVE-LINE')
    expect(cache?.textHash).toBe(agyTextHash('first question'))
  })

  it('mid-turn invocation replays the cached message WITHOUT re-recalling', async () => {
    const t = transcript({ step: 0, text: 'first question' })
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: t })
    await run([], {} as never)
    expect(injectCalls).toHaveLength(1)

    written = []
    setStdin({ conversationId: SID, invocationNum: 1, transcriptPath: t })
    await run([], {} as never)

    expect(injectCalls).toHaveLength(1) // no second recall
    expect(emittedMessage()).toContain('DIRECTIVE-LINE') // but the memory is re-shown
  })

  it('a new user message is a new turn — new recall, new cache', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: transcript({ step: 0, text: 'first question' }) })
    await run([], {} as never)

    injectResult = { count: 1, directives: 'SECOND-TURN', constraints: '', consider: '' }
    written = []
    setStdin({
      conversationId: SID, invocationNum: 3,
      transcriptPath: transcript({ step: 0, text: 'first question' }, { step: 5, text: 'second question' }),
    })
    await run([], {} as never)

    expect(injectCalls).toHaveLength(2)
    expect(injectCalls[1].task).toBe('second question')
    expect(emittedMessage()).toContain('SECOND-TURN')
  })

  // Evaluator audit M6 / adversarial audit F4: step_index is Antigravity's
  // internal counter. If it disappears (all -1) or restarts, a step-only
  // comparison freezes on turn one forever. The text hash breaks the tie.
  it('detects a new turn by TEXT when step_index does not advance', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: transcript({ step: 0, text: 'alpha' }) })
    await run([], {} as never)

    written = []
    setStdin({ conversationId: SID, invocationNum: 4, transcriptPath: transcript({ step: 0, text: 'beta' }) })
    await run([], {} as never)

    expect(injectCalls).toHaveLength(2)
    expect(injectCalls[1].task).toBe('beta')
  })

  // Evaluator audit M5: an empty injection result is still THIS turn's
  // result. Not caching it made every mid-turn invocation re-run a full
  // (multi-second) recall.
  it('caches an empty result so mid-turn invocations do not re-recall', async () => {
    injectResult = { count: 0, directives: '', constraints: '', consider: '' }
    const t = transcript({ step: 2, text: 'question with no matches' })

    setStdin({ conversationId: SID, invocationNum: 1, transcriptPath: t })
    await run([], {} as never)
    expect(injectCalls).toHaveLength(1)
    expect(written).toEqual([]) // nothing worth emitting

    setStdin({ conversationId: SID, invocationNum: 2, transcriptPath: t })
    await run([], {} as never)
    expect(injectCalls).toHaveLength(1) // and no re-recall either
  })

  // Data-loss audit F9: sanitized ids collide on the cache PATH; the id
  // stored inside the record must keep conversations apart.
  it('never replays another conversation’s cache after a sanitized-id collision', async () => {
    writeAgyTurnCache({
      conversationId: 'agy-preinv-test.conversation', // collides with SID on path
      step: 99,
      textHash: 'whatever',
      message: 'OTHER CONVERSATION MEMORY',
    })

    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: transcript({ step: 0, text: 'mine' }) })
    await run([], {} as never)

    expect(injectCalls).toHaveLength(1) // treated as no cache → fresh recall
    expect(emittedMessage()).not.toContain('OTHER CONVERSATION MEMORY')
  })

  // Evaluator audit B1: agy runs hooks with cwd = ~/.gemini/config, where a
  // project-config walk can never succeed. The workspace path from the
  // payload is the only correct root for .plur.yaml discovery.
  it('resolves project config from the workspace path, not process.cwd()', async () => {
    stubbedScope = 'project:from-workspace'
    writeFileSync(join(dir, '.plur.yaml'), 'scope: project:from-workspace\n')
    setStdin({
      conversationId: SID, invocationNum: 0,
      transcriptPath: transcript({ step: 0, text: 'scoped question' }),
      workspacePaths: [dir],
    })
    await run([], {} as never)

    expect(projectConfigCalls).toEqual([dir])
    expect(injectCalls[0].opts.scope).toBe('project:from-workspace')
    expect(emittedMessage()).toContain('project:from-workspace')
  })

  it('replays the cached turn when the transcript becomes unreadable, and says so on stderr', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: transcript({ step: 0, text: 'alpha' }) })
    await run([], {} as never)

    written = []
    setStdin({ conversationId: SID, invocationNum: 2, transcriptPath: join(dir, 'gone.jsonl') })
    await run([], {} as never)

    expect(injectCalls).toHaveLength(1)
    expect(emittedMessage()).toContain('DIRECTIVE-LINE')
    expect(stderr.mock.calls.some(c => String(c[0]).includes('transcript unreadable'))).toBe(true)
  })

  it('emits nothing and recalls nothing without a conversationId', async () => {
    setStdin({ invocationNum: 0, transcriptPath: transcript({ step: 0, text: 'x' }) })
    await run([], {} as never)
    expect(injectCalls).toEqual([])
    expect(written).toEqual([])
  })
})
