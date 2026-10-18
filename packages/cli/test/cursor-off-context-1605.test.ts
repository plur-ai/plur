import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { writeContextRule } from '../src/lib/cursor-hook-io.js'
const CLI = builtCliPath(join(__dirname, '..'))

it('removes only generated context/reminders in every off workspace root, without session writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'plur-cursor-off-'))
  try {
    const store = join(home, '.plur'), temp = join(home, 'tmp'), neutral = join(home, 'neutral')
    const roots = [join(home, 'project'), join(home, 'project2')]
    for (const dir of [store, temp, neutral, ...roots]) mkdirSync(dir)
    const context = (dir: string) => join(dir, '.cursor/rules/plur-context.mdc')
    const reminder = (dir: string) => join(dir, '.cursor/rules/plur-reminder.mdc')
    for (const root of roots) {
      writeContextRule('[PLUR Memory — session started] old memory', context(root))
      writeContextRule('Call plur_session_start', reminder(root))
    }
    const own = join(roots[0], '.cursor/rules/user.mdc'); writeFileSync(own, 'user rule')
    writeFileSync(join(store, 'folders.yaml'), 'version: 1\nfolders:\n' + roots.map(p => `  - path: ${JSON.stringify(p)}\n    plur: off\n`).join(''))
    const invoke = () => spawnSync(process.execPath, [CLI, 'hook-cursor-session-start'], {
      cwd: neutral, encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ conversation_id: 'off-test', workspace_roots: roots }),
      env: { ...isolatedHomeEnv(home), TMPDIR: temp, TEMP: temp, TMP: temp, PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    const result = invoke(); expect(result.status).toBe(0); expect(result.stdout).toBe('')
    for (const root of roots) { expect(existsSync(context(root))).toBe(false); expect(existsSync(reminder(root))).toBe(false) }
    expect(readFileSync(own, 'utf8')).toBe('user rule')
    expect(readdirSync(temp)).toEqual([])
    // A user's replacement at our usual filename is not generated content.
    writeFileSync(context(roots[0]), 'my own context'); invoke()
    expect(readFileSync(context(roots[0]), 'utf8')).toBe('my own context')
    // Cleanup must not traverse a project-controlled rules-directory link.
    if (process.platform !== 'win32') {
      const outside = join(home, 'outside'); mkdirSync(outside)
      writeContextRule('outside generated memory', join(outside, 'plur-context.mdc'))
      rmSync(join(roots[1], '.cursor/rules'), { recursive: true, force: true })
      symlinkSync(outside, join(roots[1], '.cursor/rules'))
      invoke(); expect(existsSync(join(outside, 'plur-context.mdc'))).toBe(true)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 60000)
