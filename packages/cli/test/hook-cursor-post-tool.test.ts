import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

// Every conversation_id this file's tests use. The shared sessions dir is
// also used by the sibling hook-cursor-{session-start,guard,stop} test
// files, which run in parallel under vitest's default file concurrency —
// recursively deleting the whole directory here would race-delete files a
// sibling file just wrote and is about to assert on. Clean up only the
// files this file's own tests created, by conversation_id.
const CONVERSATION_IDS = ['conv-cloud-1', 'conv-cloud-2', 'conv-cloud-3']

function cleanupSessionFiles(conversationId: string): void {
  for (const suffix of ['.marker', '.reminded', '.stopcount', '.marker.guard-count']) {
    rmSync(join(SESSIONS_DIR, `${conversationId}${suffix}`), { force: true })
  }
}

describe('hook-cursor-post-tool', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'plur-cursor-post-project-'))
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

  it('marks the sentinel when plur_session_start is the tool called', () => {
    execSync(`node ${CLI} hook-cursor-post-tool`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-cloud-1', tool_name: 'plur_session_start' }),
      encoding: 'utf-8',
    })
    expect(existsSync(join(SESSIONS_DIR, 'conv-cloud-1.marker'))).toBe(true)
  })

  it('stays silent for other tools when no sentinel exists yet', () => {
    const output = execSync(`node ${CLI} hook-cursor-post-tool`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-cloud-2', tool_name: 'some_other_tool' }),
      encoding: 'utf-8',
    })
    expect(output.trim()).toBe('')
  })

  it('emits a reminder for other tools once the sentinel exists and the reminder is due', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, 'conv-cloud-3.marker'), String(Date.now()))
    const output = execSync(`node ${CLI} hook-cursor-post-tool`, {
      cwd: projectDir,
      input: JSON.stringify({ conversation_id: 'conv-cloud-3', tool_name: 'some_other_tool' }),
      encoding: 'utf-8',
    })
    const parsed = JSON.parse(output)
    expect(parsed.additional_context).toContain('plur_learn')

    // Primary channel (audit fix, live evidence): postToolUse's
    // additional_context is confirmed broken by Cursor's own team too.
    const ruleContent = readFileSync(join(projectDir, '.cursor', 'rules', 'plur-context.mdc'), 'utf-8')
    expect(ruleContent).toContain('plur_learn')
  })
})
