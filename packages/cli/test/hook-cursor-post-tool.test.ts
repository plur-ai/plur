import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

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
    rmSync(SESSIONS_DIR, { recursive: true, force: true })
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
