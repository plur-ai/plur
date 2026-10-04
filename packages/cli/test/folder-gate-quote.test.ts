/**
 * The folder question prints `plur folders set <folder> ... --nonce <n>` for
 * the agent to run. The nonce is bound to the exact folder string, so the
 * shell must hand `plur` the path byte for byte.
 *
 * The Windows fresh-install run: `C:\Users\x\proj` has no space, so it was
 * printed unquoted; Git Bash (a POSIX shell) read the backslashes as escapes
 * and `plur` received `C:Usersxproj`, which the nonce check refused.
 *
 * This runs each printed command through a real POSIX shell with `plur`
 * stubbed to print its argv. PowerShell and cmd are not available on every
 * CI runner, so for them the test pins the form they accept: a bare token of
 * strictly safe characters, or the path in double quotes with no character
 * either shell expands inside double quotes.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { quoted } from '../src/lib/folder-gate.js'

const posix = process.platform !== 'win32'

function argvThroughSh(command: string, cwd?: string): string[] {
  const script = `plur() { for a in "$@"; do printf '%s\\n' "$a"; done; }; ${command}`
  const r = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', cwd })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.replace(/\n$/, '').split('\n')
}

const PATHS = [
  'C:\\Users\\x\\proj',
  'C:\\Users\\x\\my proj',
  'D:\\a\\plur\\plur\\e2e-home\\repo',
  'C:/Users/x/proj',
  '/home/x/proj',
  '/home/x/my proj',
  '/Users/x/Data/5-plur/2-projects/plur',
  "/home/x/it's here",
  '/home/x/a&b(c);d',
]

// #1418 review: double quotes do not stop a POSIX shell expanding $(...) or
// backticks, so a folder named like a command ran it. POSIX paths only.
const POSIX_ONLY = [
  '/home/x/$(touch pwned)',
  '/home/x/`touch pwned`',
  '/home/x/$HOME and ${PATH}',
  "/home/x/it's $(touch pwned)",
  '/home/x/"quoted" \\ back',
]

describe('quoted(): the folder in the printed "yes" command reaches plur unchanged', () => {
  it.skipIf(!posix).each([...PATHS, ...POSIX_ONLY])('POSIX sh: %s', (path) => {
    const cwd = mkdtempSync(join(tmpdir(), 'plur-quote-'))
    try {
      const argv = argvThroughSh(`plur folders set ${quoted(path, 'darwin')} --on --nonce 0123`, cwd)
      expect(argv[2]).toBe(path)
      expect(argv).toEqual(['folders', 'set', path, '--on', '--nonce', '0123'])
      expect(existsSync(join(cwd, 'pwned'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('POSIX: anything but a safe bare token goes in single quotes', () => {
    expect(quoted('/home/x/$(touch pwned)', 'linux')).toBe("'/home/x/$(touch pwned)'")
    expect(quoted("/home/x/it's", 'darwin')).toBe("'/home/x/it'\\''s'")
    expect(quoted('/home/x/proj', 'darwin')).toBe('/home/x/proj')
  })

  it('a Windows path with backslashes is always quoted', () => {
    expect(quoted('C:\\Users\\x\\proj', 'win32')).toBe('"C:\\Users\\x\\proj"')
  })

  it.each(PATHS)('cmd and PowerShell form: %s', (path) => {
    const q = quoted(path, 'win32')
    if (q === path) {
      // Bare: only characters no shell treats specially.
      expect(path).toMatch(/^[A-Za-z0-9_./:-]+$/)
    } else {
      // Double-quoted verbatim. Inside double quotes cmd expands % and !,
      // PowerShell expands $ and `, and a quote or a trailing backslash would
      // end the argument early under the Windows argv rules.
      expect(q).toBe(`"${path}"`)
      expect(path).not.toMatch(/["%!$`]|\\$/)
    }
  })
})
