import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur init --cursor', () => {
  let home: string
  let project: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-init-cursor-home-'))
    project = mkdtempSync(join(tmpdir(), 'plur-init-cursor-project-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  function runInit(extra: string): string {
    return execSync(`node ${CLI} init --no-desktop ${extra}`, {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: project,
    })
  }

  it('does nothing Cursor-specific without .cursor/ or --cursor', () => {
    runInit('')
    expect(existsSync(join(project, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('auto-detects an existing .cursor/ directory', () => {
    mkdirSync(join(project, '.cursor'))
    const output = runInit('')
    expect(output).toContain('Cursor')
    expect(existsSync(join(project, '.cursor', 'mcp.json'))).toBe(true)
  })

  it('--cursor forces setup even without a pre-existing .cursor/ dir', () => {
    runInit('--cursor')

    const mcpConfig = JSON.parse(readFileSync(join(project, '.cursor', 'mcp.json'), 'utf-8'))
    expect(mcpConfig.mcpServers.plur).toBeDefined()
    expect(mcpConfig.mcpServers.plur.env.PLUR_TOOL_PROFILE).toBe('cursor')

    const hooksConfig = JSON.parse(readFileSync(join(project, '.cursor', 'hooks.json'), 'utf-8'))
    expect(hooksConfig.hooks.sessionStart[0].command).toContain('hook-cursor-session-start')
    expect(hooksConfig.hooks.preToolUse[0].command).toContain('hook-cursor-guard')
    expect(hooksConfig.hooks.postToolUse[0].command).toContain('hook-cursor-post-tool')
    expect(hooksConfig.hooks.stop[0].command).toContain('hook-cursor-stop')

    const rule = readFileSync(join(project, '.cursor', 'rules', 'plur-memory.mdc'), 'utf-8')
    expect(rule).toContain('alwaysApply: true')
    expect(rule).toContain('plur_recall_hybrid')
  })

  it('--no-cursor skips Cursor setup even with a .cursor/ dir present', () => {
    mkdirSync(join(project, '.cursor'))
    runInit('--no-cursor')
    expect(existsSync(join(project, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('is idempotent — running twice does not duplicate hooks', () => {
    runInit('--cursor')
    runInit('--cursor')
    const hooksConfig = JSON.parse(readFileSync(join(project, '.cursor', 'hooks.json'), 'utf-8'))
    expect(hooksConfig.hooks.sessionStart.length).toBe(1)
  })

  // Audit fix (data evaluator): a pre-existing plur entry without the cursor
  // profile env used to be left untouched — silently defeating Task 1's
  // tool-budget fix while still reporting "already registered."
  it('patches a pre-existing plur entry that is missing the cursor tool profile', () => {
    mkdirSync(join(project, '.cursor'), { recursive: true })
    writeFileSync(
      join(project, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }),
    )
    const output = runInit('--cursor')
    expect(output).toContain('patched')

    const mcpConfig = JSON.parse(readFileSync(join(project, '.cursor', 'mcp.json'), 'utf-8'))
    expect(mcpConfig.mcpServers.plur.env.PLUR_TOOL_PROFILE).toBe('cursor')
  })

  // Audit fix (dijkstra evaluator): a malformed hooks.json must not be
  // silently clobbered with an empty config.
  it('refuses to overwrite a malformed .cursor/hooks.json', () => {
    mkdirSync(join(project, '.cursor'), { recursive: true })
    writeFileSync(join(project, '.cursor', 'hooks.json'), '{ not valid json')
    const output = runInit('--cursor')
    expect(output).toContain('skipped')

    const raw = readFileSync(join(project, '.cursor', 'hooks.json'), 'utf-8')
    expect(raw).toBe('{ not valid json')
  })
})
