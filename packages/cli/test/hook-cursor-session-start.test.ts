import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

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
