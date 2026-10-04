/**
 * #1228's r2-cli session-mark fix widened the PostToolUse matcher from
 * `mcp__plur__plur_session_start` to `mcp__.*__plur_session_start`
 * (formal-gaps-session-mark-matcher). An install that already has the old
 * entry must end up, after re-running `plur init` (and `plur-mcp init`), with
 * exactly one session-mark entry, the new one: the old entry must not survive
 * beside it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const MCP = join(__dirname, '..', '..', 'mcp', 'dist', 'index.js')

interface Entry { matcher?: string; hooks: Array<{ command?: string; args?: string[] }> }

describe.skipIf(process.platform === 'win32')('upgrade from the old session-mark matcher', { timeout: 60000 }, () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-mark-upgrade-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    // What an earlier `plur init` wrote.
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: 'mcp__plur__plur_session_start',
          hooks: [{ type: 'command', command: `${join(home, '.plur', 'bin', 'plur-hook')} hook-session-mark`, timeout: 3 }],
        }],
      },
    }, null, 2))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const markEntries = (): Entry[] => {
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as { hooks?: Record<string, Entry[]> }
    return Object.values(s.hooks ?? {}).flat().filter(e =>
      e.hooks.some(h => [h.command ?? '', ...(h.args ?? [])].join(' ').includes('hook-session-mark')))
  }
  const plurInit = () => execFileSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-codex', '--no-antigravity', '--no-cursor'], {
    encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
  })

  it('plur init replaces the old entry with exactly one new one', () => {
    plurInit()
    const marks = markEntries()
    expect(marks.map(e => e.matcher)).toEqual(['mcp__.*__plur_session_start'])
  })

  it.skipIf(!existsSync(MCP))('plur-mcp init then plur init: still exactly one, the new one', () => {
    execFileSync(process.execPath, [MCP, 'init'], { encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home })
    // plur-mcp init writes no session-mark hook and leaves this one alone.
    expect(markEntries().map(e => e.matcher)).toEqual(['mcp__plur__plur_session_start'])
    plurInit()
    expect(markEntries().map(e => e.matcher)).toEqual(['mcp__.*__plur_session_start'])
  })
})
