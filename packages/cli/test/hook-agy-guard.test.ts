import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'fs'
import { run as runGuard } from '../src/commands/hook-agy-guard.js'
import {
  agySentinelPath,
  agyCounterPath,
  agyMarkSessionStarted,
  agyIsSessionStarted,
} from '../src/lib/agy-hook-io.js'

/**
 * Enforcement logic for the agy guard. Like the Codex guard tests, these
 * prove the process emits the right verdicts and can never deadlock the
 * agent — they cannot prove agy honours a deny, which was verified live
 * (agy 1.1.21: "tool call denied by pre-tool hook: ..." reached the model).
 */

const SID = 'agy-guard-test-conversation'

// runAgyHook force-exits 0 (same wrapper as the Codex hooks); suppress in-process.
process.env.PLUR_HOOK_NO_EXIT = '1'

let written: string[]
let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

function setStdin(payload: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).__plurCodexStdin = payload
}

// The agy hooks share readStdinJson with the Codex family (re-exported from
// codex-hook-io), so the same mock hook covers both.
vi.mock('../src/lib/codex-hook-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/codex-hook-io.js')>()
  return {
    ...actual,
    readStdinJson: () => (globalThis as Record<string, unknown>).__plurCodexStdin ?? {},
  }
})

function emitted(): unknown | null {
  const last = written.at(-1)
  return last ? JSON.parse(last) : null
}

function clean() {
  for (const p of [agySentinelPath(SID), agyCounterPath(SID, 'guard-count'), agyCounterPath(SID, 'laststep'), agyCounterPath(SID, 'turncount')]) {
    rmSync(p, { force: true })
  }
}

beforeEach(() => {
  clean()
  written = []
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    if (String(c).length > 0) written.push(String(c))
    return true
  }) as never)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  stdout.mockRestore()
  stderr.mockRestore()
  clean()
})

describe('hook-agy-guard', () => {
  it('denies the first tool call before the session starts, with agy’s FLAT verdict shape', async () => {
    setStdin({ conversationId: SID, toolCall: { name: 'run_command', args: {} } })
    await runGuard([], {} as never)
    const out = emitted() as { decision: string; reason: string }
    // Flat {decision, reason} — no hookSpecificOutput envelope. agy parses
    // nothing else.
    expect(out.decision).toBe('deny')
    expect(out.reason).toContain('plur_session_start')
    expect(out).not.toHaveProperty('hookSpecificOutput')
  })

  it('never emits allow — silence must not bypass agy’s own permission prompts', async () => {
    agyMarkSessionStarted(SID)
    setStdin({ conversationId: SID, toolCall: { name: 'run_command' } })
    await runGuard([], {} as never)
    expect(written).toEqual([])
  })

  it('marks the sentinel when plur_session_start passes through — PostToolUse has no tool name, so this is the only detection point', async () => {
    setStdin({ conversationId: SID, toolCall: { name: 'plur_session_start' } })
    await runGuard([], {} as never)
    expect(agyIsSessionStarted(SID)).toBe(true)
    expect(written).toEqual([])
  })

  it('recognises a prefixed MCP spelling of plur_session_start', async () => {
    setStdin({ conversationId: SID, toolCall: { name: 'mcp_plur_plur_session_start' } })
    await runGuard([], {} as never)
    expect(agyIsSessionStarted(SID)).toBe(true)
  })

  it('gives up after one nudge and marks the session started — the deadlock rule', async () => {
    setStdin({ conversationId: SID, toolCall: { name: 'run_command' } })
    await runGuard([], {} as never)
    expect((emitted() as { decision: string }).decision).toBe('deny')

    written = []
    await runGuard([], {} as never)
    expect(written).toEqual([])
    expect(agyIsSessionStarted(SID)).toBe(true)
  })

  it('allows through rather than blocking blind without a conversationId', async () => {
    setStdin({ toolCall: { name: 'run_command' } })
    await runGuard([], {} as never)
    expect(written).toEqual([])
  })

  it('tolerates a payload with no toolCall at all', async () => {
    setStdin({ conversationId: SID })
    await runGuard([], {} as never)
    // No tool name → not plur_session_start → session not started → denies.
    // The point is it must not THROW on the missing field.
    expect((emitted() as { decision: string }).decision).toBe('deny')
  })
})
