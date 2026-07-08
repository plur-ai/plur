import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

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
    rmSync(SESSIONS_DIR, { recursive: true, force: true })
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
