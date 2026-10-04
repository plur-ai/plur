/**
 * #1270 review: `plur init` deleted user hooks in which another binary runs
 * PLUR's shim (`/usr/bin/time ~/.plur/bin/plur-hook hook-inject`), because
 * the unquoted spaced-path form read the wrapper as part of the path. A
 * project `.claude/settings.json` holding such hooks must come out of
 * `plur init` with every one of them untouched, on darwin/linux and on
 * Windows (the built CLI spawned with the win32 preload).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

interface HookSpec { type?: string; command: string; args?: string[]; timeout?: number }
interface Entry { matcher?: string; hooks: HookSpec[] }
interface Settings { hooks?: Record<string, Entry[]> }

/** User hooks that run PLUR's shim through another binary. None is PLUR's. */
function userHooks(home: string): string[] {
  return [
    '/usr/bin/time ~/.plur/bin/plur-hook hook-inject',
    '/usr/bin/nice -n 5 ~/.plur/bin/plur-hook hook-inject',
    'C:/Tools/log.exe %USERPROFILE%/.plur/bin/plur-hook.cmd hook-inject',
    '/home/me/bin/notify-slack.sh --then ./.plur/bin/plur-hook hook-inject',
    'C:/evil.exe -x=c:/x/.plur/bin/plur-hook hook-inject',
    '/usr/bin/env ~/.plur/bin/plur-hook hook-inject',
    '/usr/bin/env FOO=1 ./.plur/bin/plur-hook hook-inject',
    'nice -n 5 ~/.plur/bin/plur-hook hook-inject',
    // A wrapper in front of this very home's shim is still the user's.
    `/usr/bin/time ${join(home, '.plur', 'bin', 'plur-hook')} hook-inject`,
    `C:/Tools/log.exe ${join(home, '.plur', 'bin', 'plur-hook.cmd')} hook-inject`,
  ]
}

describe('plur init keeps user hooks that wrap the PLUR shim (#1270 review)', { timeout: 60000 }, () => {
  let home: string
  let project: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'Test User-'))
    project = join(home, 'project')
    mkdirSync(join(project, '.claude'), { recursive: true })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it.each([['darwin/linux', false], ['win32', true]])('%s: every user hook survives, untouched', (_label, win32) => {
    const hooks = userHooks(home)
    const entries: Entry[] = hooks.map((command) => ({ hooks: [{ type: 'command', command, timeout: 7 }] }))
    const before: Settings = {
      hooks: {
        UserPromptSubmit: entries,
        PreToolUse: [{ matcher: 'Bash', hooks: hooks.map((command) => ({ type: 'command', command })) }],
      },
    }
    const settingsPath = join(project, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(before, null, 2))

    execFileSync(process.execPath, [...(win32 ? ['--import', WIN32_PRELOAD] : []), CLI, 'init', '--project', '--no-desktop', '--no-codex', '--no-antigravity', '--no-opencode'], {
      encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: project,
    })

    const after: Settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    // Init added its own hooks (so it did run its merge over these events)...
    expect(after.hooks?.UserPromptSubmit?.length).toBeGreaterThan(entries.length)
    // ...and every user entry is still there, byte for byte, in order.
    const keptUps = after.hooks?.UserPromptSubmit?.filter((e) => e.hooks.some((h) => hooks.includes(h.command)))
    expect(keptUps).toEqual(entries)
    const keptPre = after.hooks?.PreToolUse?.filter((e) => e.hooks.some((h) => hooks.includes(h.command)))
    expect(keptPre).toEqual(before.hooks!.PreToolUse)
  })
})
