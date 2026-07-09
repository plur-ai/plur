import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

// Every conversation_id this file's tests use. The shared sessions dir
// (join(tmpdir(), 'plur-cursor-sessions')) is also used by the sibling
// hook-cursor-{session-start,post-tool,stop} test files, which run in
// parallel under vitest's default file concurrency — recursively deleting
// the whole directory here would race-delete files a sibling file just wrote
// and is about to assert on. Clean up only the files this file's own tests
// created, by conversation_id.
const CONVERSATION_IDS = ['conv-no-session', 'conv-started', 'conv-fresh', 'conv-fallback']

function cleanupSessionFiles(conversationId: string): void {
  for (const suffix of ['.marker', '.reminded', '.stopcount', '.marker.guard-count']) {
    rmSync(join(SESSIONS_DIR, `${conversationId}${suffix}`), { force: true })
  }
}

describe('hook-cursor-guard', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'plur-cursor-guard-project-'))
    mkdirSync(join(projectDir, '.cursor'), { recursive: true })
    writeFileSync(
      join(projectDir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }),
    )
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    for (const id of CONVERSATION_IDS) cleanupSessionFiles(id)
  })

  it('denies a tool call when no sentinel exists for the conversation', () => {
    const output = execSync(`node ${CLI} hook-cursor-guard`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-no-session', tool_name: 'some_tool' }),
      encoding: 'utf-8',
    })
    const parsed = JSON.parse(output)
    expect(parsed.permission).toBe('deny')
  })

  it('allows through once the sentinel exists', () => {
    mkdirSync(join(tmpdir(), 'plur-cursor-sessions'), { recursive: true })
    writeFileSync(join(tmpdir(), 'plur-cursor-sessions', 'conv-started.marker'), String(Date.now()))
    const output = execSync(`node ${CLI} hook-cursor-guard`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-started', tool_name: 'some_tool' }),
      encoding: 'utf-8',
    })
    expect(output.trim()).toBe('')
  })

  it('always allows plur_session_start through, even before the sentinel exists', () => {
    const output = execSync(`node ${CLI} hook-cursor-guard`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-fresh', tool_name: 'plur_session_start' }),
      encoding: 'utf-8',
    })
    expect(output.trim()).toBe('')
  })

  // Audit fix (critic + data evaluators): the fallback-open path used to
  // leave the session permanently un-started from hook-cursor-post-tool's
  // point of view, silencing reminders for the rest of the conversation.
  // Confirm the 2nd blocked call both allows AND marks the sentinel.
  it('marks the sentinel when falling back open after the block threshold', () => {
    const conversationId = 'conv-fallback'
    const payload = JSON.stringify({ conversation_id: conversationId, tool_name: 'some_tool' })

    const first = execSync(`node ${CLI} hook-cursor-guard`, { cwd: projectDir, input: payload, encoding: 'utf-8' })
    expect(JSON.parse(first).permission).toBe('deny')
    expect(existsSync(join(tmpdir(), 'plur-cursor-sessions', `${conversationId}.marker`))).toBe(false)

    const second = execSync(`node ${CLI} hook-cursor-guard`, { cwd: projectDir, input: payload, encoding: 'utf-8' })
    expect(second.trim()).toBe('')
    expect(existsSync(join(tmpdir(), 'plur-cursor-sessions', `${conversationId}.marker`))).toBe(true)
  })

  // Audit fix (evaluator review, iteration 3, 2026-07-09): every hook
  // invocation calls sessionsDir(), which now prunes marker files older
  // than 7 days — without this, every unique conversation_id left orphaned
  // files in $TMPDIR/plur-cursor-sessions/ forever.
  it('prunes session files older than 7 days on any hook invocation', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const staleMarker = join(SESSIONS_DIR, 'conv-ancient.marker')
    writeFileSync(staleMarker, 'old')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(staleMarker, eightDaysAgo, eightDaysAgo)

    // NOT tool_name: 'plur_session_start' — that path returns before ever
    // touching sentinelPath()/sessionsDir(), so pruning would never trigger.
    execSync(`node ${CLI} hook-cursor-guard`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-fresh', tool_name: 'some_other_tool' }),
      encoding: 'utf-8',
    })

    expect(existsSync(staleMarker)).toBe(false)
  })

  // Audit fix (evaluator review, iteration 5, 2026-07-09): safeSessionKey's
  // "closes path traversal" claim (cursor-hook-io.ts) had zero regression
  // coverage — every fixture across all four hook-cursor-*.test.ts files
  // used a plain conv-abc-123-style id. Prove a conversation_id containing
  // `../` segments neither crashes the hook nor escapes SESSIONS_DIR.
  it('sanitizes a conversation_id containing path-traversal characters', () => {
    const conversationId = '../../../etc/evil'
    const safeKey = conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
    const guardCountFile = join(SESSIONS_DIR, `${safeKey}.marker.guard-count`)

    const output = execSync(`node ${CLI} hook-cursor-guard`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: conversationId, tool_name: 'some_tool' }),
      encoding: 'utf-8',
    })

    expect(JSON.parse(output).permission).toBe('deny')
    // Landed inside SESSIONS_DIR under the sanitized name, not escaped via `../`.
    expect(existsSync(guardCountFile)).toBe(true)
    rmSync(guardCountFile, { force: true })
  })
})
