import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { run as runGuard } from '../src/commands/hook-codex-guard.js'
import { run as runPostTool } from '../src/commands/hook-codex-post-tool.js'
import {
  sentinelPath,
  counterPath,
  markSessionStarted,
  isSessionStarted,
} from '../src/lib/codex-hook-io.js'

/**
 * These exercise the ENFORCEMENT logic, which is the part that can wedge a
 * user's session. They cannot prove Codex honours the deny — only a live
 * `codex exec` run can, and that was done manually against codex-cli 0.149.1
 * (a denied shell call, with the reason reaching the model). What they do
 * prove is that this process emits the right envelope, and never emits one
 * that would deadlock the agent.
 */

const SID = 'codex-guard-test-session'

// runCodexHook force-exits 0 so a background crash can never make Codex
// discard a hook's output (or, on PreToolUse, block the tool). In-process
// tests need that suppressed or the runner exits mid-suite.
process.env.PLUR_HOOK_NO_EXIT = '1'

let projectDir: string
let cwdSpy: ReturnType<typeof vi.spyOn>
let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

/** Make isPlurConfigured() true by putting a .plur.yaml in a scratch cwd. */
function makePlurProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-codex-guard-'))
  writeFileSync(join(dir, '.plur.yaml'), 'scope: project:test\n')
  return dir
}

let written: string[]

function emitted(): unknown | null {
  const last = written.at(-1)
  return last ? JSON.parse(last) : null
}

beforeEach(() => {
  written = []
  projectDir = makePlurProject()
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir)
  // Record only non-empty writes. runCodexHook flushes with a zero-length
  // write before exiting; that is not output, and counting it would make
  // every "stays silent" assertion fail on a hook that said nothing.
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    if (String(chunk).length > 0) written.push(String(chunk))
    return true
  }) as never)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  for (const p of [sentinelPath(SID), counterPath(SID, 'guard-count'), counterPath(SID, 'tool-count')]) {
    rmSync(p, { force: true })
  }
})

afterEach(() => {
  cwdSpy.mockRestore()
  stdout.mockRestore()
  stderr.mockRestore()
  rmSync(projectDir, { recursive: true, force: true })
  for (const p of [sentinelPath(SID), counterPath(SID, 'guard-count'), counterPath(SID, 'tool-count')]) {
    rmSync(p, { force: true })
  }
})

/**
 * The hook commands read stdin via readSync(0, ...). Rather than fight fd 0
 * inside the test runner, stub the shared reader the way the Cursor hook
 * tests do: mock the module's readStdinJson through vi.mock at import time.
 */
vi.mock('../src/lib/codex-hook-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/codex-hook-io.js')>()
  return {
    ...actual,
    readStdinJson: () => (globalThis as Record<string, unknown>).__plurCodexStdin ?? {},
  }
})

function setStdin(payload: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).__plurCodexStdin = payload
}

describe('hook-codex-guard', () => {
  it('stays silent when the session has already started', async () => {
    markSessionStarted(SID)
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runGuard([], {} as never)
    expect(written).toEqual([])
  })

  it('denies the first tool call before the session starts', async () => {
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runGuard([], {} as never)
    expect(emitted()).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    })
  })

  it('always pairs a deny with a non-empty reason', async () => {
    // Codex rejects the output otherwise: "PreToolUse hook returned
    // permissionDecision:deny without a non-empty permissionDecisionReason".
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runGuard([], {} as never)
    const out = emitted() as { hookSpecificOutput: { permissionDecisionReason?: string } }
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeTruthy()
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('plur_session_start')
  })

  it('never emits allow or ask — Codex rejects both from a hook', async () => {
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runGuard([], {} as never)
    const out = JSON.stringify(emitted())
    expect(out).not.toContain('"allow"')
    expect(out).not.toContain('"ask"')
  })

  it('never denies plur_session_start itself', async () => {
    setStdin({ session_id: SID, tool_name: 'plur__plur_session_start' })
    await runGuard([], {} as never)
    expect(written).toEqual([])
  })

  // The deadlock guard (#199's rule, ported). A wedged MCP server must not be
  // able to lock the agent into a state where the only permitted tool is one
  // it cannot reach.
  it('gives up after one nudge and marks the session started anyway', async () => {
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runGuard([], {} as never)
    expect(emitted()).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })

    written = []
    await runGuard([], {} as never)
    expect(written).toEqual([])
    expect(isSessionStarted(SID)).toBe(true)
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('degraded mode')
  })

  it('allows through rather than blocking blind when there is no session id', async () => {
    setStdin({ tool_name: 'shell' })
    await runGuard([], {} as never)
    expect(written).toEqual([])
  })

  it('stays silent entirely in a project that has no plur config', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'no-plur-'))
    mkdirSync(join(bare, 'sub'), { recursive: true })
    cwdSpy.mockReturnValue(join(bare, 'sub'))
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runGuard([], {} as never)
    expect(written).toEqual([])
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('hook-codex-post-tool', () => {
  it('marks the sentinel when the agent calls plur_session_start itself', async () => {
    setStdin({ session_id: SID, tool_name: 'plur__plur_session_start' })
    await runPostTool([], {} as never)
    expect(isSessionStarted(SID)).toBe(true)
    // Marking is the whole job here — no nudge on the same call.
    expect(written).toEqual([])
  })

  it('does not nudge before the session has started', async () => {
    setStdin({ session_id: SID, tool_name: 'shell' })
    await runPostTool([], {} as never)
    expect(written).toEqual([])
  })

  it('nudges once every N tools, not on every tool', async () => {
    markSessionStarted(SID)
    setStdin({ session_id: SID, tool_name: 'shell' })

    let nudges = 0
    for (let i = 0; i < 24; i++) {
      written = []
      await runPostTool([], {} as never)
      if (written.length > 0) {
        nudges++
        expect(emitted()).toMatchObject({
          hookSpecificOutput: { hookEventName: 'PostToolUse' },
        })
      }
    }
    expect(nudges).toBe(2)
  })

  it('mentions plur_learn and plur_session_end in the nudge', async () => {
    markSessionStarted(SID)
    setStdin({ session_id: SID, tool_name: 'shell' })
    for (let i = 0; i < 12; i++) await runPostTool([], {} as never)
    const out = emitted() as { hookSpecificOutput: { additionalContext: string } }
    expect(out.hookSpecificOutput.additionalContext).toContain('plur_learn')
    expect(out.hookSpecificOutput.additionalContext).toContain('plur_session_end')
  })
})
