import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

// Every conversation_id this file's tests use. The shared sessions dir is
// also used by the sibling hook-cursor-{session-start,guard,post-tool} test
// files, which run in parallel under vitest's default file concurrency —
// recursively deleting the whole directory here would race-delete files a
// sibling file just wrote and is about to assert on. Clean up only the
// files this file's own tests created, by conversation_id.
const CONVERSATION_IDS = ['conv-stop-1', 'conv-stop-2']

function cleanupSessionFiles(conversationId: string): void {
  for (const suffix of ['.marker', '.reminded', '.stopcount', '.marker.guard-count']) {
    rmSync(join(SESSIONS_DIR, `${conversationId}${suffix}`), { force: true })
  }
}

describe('hook-cursor-stop', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'plur-cursor-stop-project-'))
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

  function stop(conversationId: string, status = 'completed'): string {
    return execSync(`node ${CLI} hook-cursor-stop`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: conversationId, status }),
      encoding: 'utf-8',
    })
  }

  it('stays silent on the 1st and 2nd stop, nudges on the 3rd', () => {
    expect(stop('conv-stop-1').trim()).toBe('')
    expect(stop('conv-stop-1').trim()).toBe('')
    const third = JSON.parse(stop('conv-stop-1'))
    expect(third.followup_message).toContain('plur_learn')
  })

  it('does not count or nudge on aborted/error stops', () => {
    expect(stop('conv-stop-2', 'aborted').trim()).toBe('')
    expect(stop('conv-stop-2', 'error').trim()).toBe('')
    expect(stop('conv-stop-2', 'aborted').trim()).toBe('')
  })
})
