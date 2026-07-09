import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

// Every conversation_id this file's tests use. Cleaned up per-id (not via a
// recursive rmSync of the shared SESSIONS_DIR) for the same reason commit
// 862fa21 fixed the sibling hook-cursor-{guard,post-tool,stop} test files:
// that directory is shared across all four hook-cursor-*.test.ts files,
// which run in parallel under vitest's default file concurrency — a
// recursive wipe here would race-delete a sibling's in-progress fixtures.
// This file wasn't part of that fix (it doesn't do the destructive wipe, so
// it never caused the race), but it also never cleaned up its OWN
// markSessionStarted() output (audit fix — evaluator review, iteration 2,
// 2026-07-09) — leaking .marker/.reminded files into the OS temp dir
// indefinitely across test runs.
const CONVERSATION_IDS = ['conv-abc-123']

function cleanupSessionFiles(conversationId: string): void {
  for (const suffix of ['.marker', '.reminded', '.stopcount', '.marker.guard-count']) {
    rmSync(join(SESSIONS_DIR, `${conversationId}${suffix}`), { force: true })
  }
}

describe('hook-cursor-session-start', () => {
  let projectDir: string
  let plurHome: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'plur-cursor-project-'))
    plurHome = mkdtempSync(join(tmpdir(), 'plur-cursor-store-'))
    // Mark the project as plur-configured so the hook doesn't silently no-op.
    mkdirSync(join(projectDir, '.cursor'), { recursive: true })
    writeFileSync(
      join(projectDir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }),
    )
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(plurHome, { recursive: true, force: true })
    for (const id of CONVERSATION_IDS) cleanupSessionFiles(id)
  })

  it('writes a sentinel, the dynamic context rule, and prints additional_context', () => {
    const output = execSync(`node ${CLI} hook-cursor-session-start`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-abc-123', is_background_agent: false }),
      encoding: 'utf-8',
      env: { ...process.env, PLUR_PATH: plurHome },
    })
    const parsed = JSON.parse(output)
    expect(parsed.additional_context).toContain('session started')

    const sentinel = join(tmpdir(), 'plur-cursor-sessions', 'conv-abc-123.marker')
    expect(existsSync(sentinel)).toBe(true)

    // Primary channel (audit fix, live evidence): additional_context alone is
    // confirmed broken by Cursor's own team — the rules file is what
    // actually needs to exist.
    const rulePath = join(projectDir, '.cursor', 'rules', 'plur-context.mdc')
    expect(existsSync(rulePath)).toBe(true)
    const ruleContent = readFileSync(rulePath, 'utf-8')
    expect(ruleContent).toContain('alwaysApply: true')
    expect(ruleContent).toContain('session started')
  })

  it('stays silent when no conversation id is present', () => {
    const output = execSync(`node ${CLI} hook-cursor-session-start`, {
      cwd: projectDir,
      input: JSON.stringify({ is_background_agent: false }),
      encoding: 'utf-8',
      env: { ...process.env, PLUR_PATH: plurHome },
    })
    expect(output.trim()).toBe('')
  })
})
