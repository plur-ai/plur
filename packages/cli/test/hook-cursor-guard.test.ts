import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

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
    rmSync(join(tmpdir(), 'plur-cursor-sessions'), { recursive: true, force: true })
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
})
