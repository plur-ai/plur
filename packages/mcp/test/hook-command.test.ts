import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { isPlurHookCommand, PLUR_SETTINGS_SUBCOMMANDS } from '../src/hook-command.js'

/**
 * `isPlurHookCommand` is a copy of @plur-ai/cli's `src/lib/hook-command.ts`
 * (#1270), because this package cannot import the cli. The same cases run
 * against the cli's copy whenever that file exists in the workspace, so the
 * two cannot drift once both are on one branch.
 */

const OURS: Array<[string, boolean]> = [
  // Every form init wrote, for every subcommand.
  ...PLUR_SETTINGS_SUBCOMMANDS.flatMap((sub): Array<[string, boolean]> => [
    [`npx @plur-ai/cli ${sub}`, true],
    [`npx -y @plur-ai/cli@0.9.1 ${sub}`, true],
    [`/home/u/.plur/bin/plur-hook ${sub}`, true],
    [`C:\\Users\\U\\.plur\\bin\\plur-hook.cmd ${sub}`, true],
    [`"C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd" ${sub}`, true],
  ]),
  ['/home/u/.plur/bin/plur-hook hook-inject --rehydrate', true],
  ['C:\\USERS\\U\\.PLUR\\BIN\\PLUR-HOOK.CMD HOOK-INJECT --rehydrate', true],
  ['plur-hook hook-observe --post', true],
  // Decision H2 (#1270, merge plan #1425): any hook-* behind PLUR's launcher
  // is PLUR's, not an allow-list, so a new hook needs no list update.
  ['npx @plur-ai/cli hook-auto-rate-mine', true],
  ['/home/u/.plur/bin/plur-hook hook-auto-rate', true],
]

const THEIRS: Array<[string, boolean]> = [
  ['npx @plur-ai/cli doctor >> ~/log', false],
  ['pwsh ~/.plur/bin/plur-hook-backup.ps1 hook-inject', false],
  ['C:\\Users\\U\\.plur\\bin\\plur-hook-backup.ps1 hook-inject', false],
  ['/home/u/.plur/bin/plur-hook status', false],
  ['/home/u/.plur/bin/my-plur-hook hook-inject', false],
  ['echo @plur-ai/cli-extra hook-inject', false],
  ['echo compacted', false],
  // Decision F4 (#1270): the whole command must be PLUR's launcher; another
  // binary running the shim, or a chained command, is the user's.
  ['/usr/bin/time ~/.plur/bin/plur-hook hook-inject', false],
  ['/home/u/.plur/bin/plur-hook hook-inject && rm -rf ~/x', false],
  ['echo /home/u/.plur/bin/plur-hook hook-inject', false],
]

const CASES = [...OURS, ...THEIRS]

describe('isPlurHookCommand', () => {
  for (const [command, expected] of CASES) {
    it(`${expected ? 'claims' : 'leaves'} ${command}`, () => {
      expect(isPlurHookCommand(command)).toBe(expected)
    })
  }
})

/**
 * The unquoted backslash path with a space that versions before #1267 wrote
 * on Windows. A space cannot tell such a path from an argument, so it is
 * claimed only when it is this machine's own shim (#1270 review): here the
 * home is `C:\\Users\\Test User`.
 */
describe('isPlurHookCommand: the unquoted spaced shim of this home', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  beforeEach(() => { process.env.HOME = 'C:\\Users\\Test User'; process.env.USERPROFILE = 'C:\\Users\\Test User' })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  for (const sub of PLUR_SETTINGS_SUBCOMMANDS) {
    it(`claims C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd ${sub}`, () => {
      expect(isPlurHookCommand(`C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd ${sub}`)).toBe(true)
    })
  }
  it('does not claim the same path under another home (a duplicate entry at worst)', () => {
    process.env.HOME = 'C:\\Users\\Someone'
    process.env.USERPROFILE = 'C:\\Users\\Someone'
    expect(isPlurHookCommand('C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd hook-inject')).toBe(false)
  })
})

const cliPath = fileURLToPath(new URL('../../cli/src/lib/hook-command.ts', import.meta.url))

describe.skipIf(!existsSync(cliPath))('isPlurHookCommand parity with @plur-ai/cli', () => {
  it('agrees with the cli copy on every case', async () => {
    const cli = (await import(/* @vite-ignore */ cliPath)) as { isPlurHookCommand: (c: string) => boolean }
    for (const [command] of CASES) {
      expect(cli.isPlurHookCommand(command), command).toBe(isPlurHookCommand(command))
    }
  })
})
