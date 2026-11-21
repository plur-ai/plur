import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, lstatSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeContextRule } from '../src/lib/cursor-hook-io.js'
import { cursorContextRulePath, cursorReminderRulePath } from '../src/mcp-config.js'

// Security audit 2026-11-06: a repository can commit .cursor, .cursor/rules or
// the generated rule file itself as a symlink. The Cursor hooks must never
// write through it into a file outside the workspace.
describe.skipIf(process.platform === 'win32')('writeContextRule refuses repository-planted symlinks', () => {
  let base: string, ws: string, outside: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-rule-link-'))
    ws = join(base, 'ws'); outside = join(base, 'outside')
    mkdirSync(ws); mkdirSync(outside)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('does not follow a symlinked leaf rule file', () => {
    const target = join(outside, 'dummy-target.txt')
    writeFileSync(target, 'DUMMY-ORIGINAL')
    mkdirSync(join(ws, '.cursor', 'rules'), { recursive: true })
    symlinkSync('../../../outside/dummy-target.txt', cursorContextRulePath(ws))
    let wrote: unknown
    try { wrote = writeContextRule('recalled memory', cursorContextRulePath(ws)) } catch { wrote = false }
    expect(readFileSync(target, 'utf8')).toBe('DUMMY-ORIGINAL')
    expect(lstatSync(cursorContextRulePath(ws)).isSymbolicLink()).toBe(true)
    expect(wrote).toBe(false)
  })

  it('does not write through a symlinked .cursor/rules directory', () => {
    writeFileSync(join(outside, 'plur-context.mdc'), 'DUMMY-ORIGINAL')
    mkdirSync(join(ws, '.cursor'))
    symlinkSync('../../outside', join(ws, '.cursor', 'rules'))
    try { writeContextRule('recalled memory', cursorContextRulePath(ws)) } catch { /* refusal may throw */ }
    try { writeContextRule('reminder', cursorReminderRulePath(ws)) } catch { /* refusal may throw */ }
    expect(readFileSync(join(outside, 'plur-context.mdc'), 'utf8')).toBe('DUMMY-ORIGINAL')
    expect(existsSync(join(outside, 'plur-reminder.mdc'))).toBe(false)
  })

  it('does not write through a symlinked .cursor directory', () => {
    symlinkSync('../outside', join(ws, '.cursor'))
    try { writeContextRule('recalled memory', cursorContextRulePath(ws)) } catch { /* refusal may throw */ }
    expect(existsSync(join(outside, 'rules'))).toBe(false)
  })

  it('still creates and rewrites the rule in a plain workspace', () => {
    writeContextRule('first', cursorContextRulePath(ws))
    writeContextRule('second', cursorContextRulePath(ws))
    const body = readFileSync(cursorContextRulePath(ws), 'utf8')
    expect(body).toContain('alwaysApply: true')
    expect(body.endsWith('second\n')).toBe(true)
  })
})
