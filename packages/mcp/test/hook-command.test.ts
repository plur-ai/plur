import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { isPlurHookCommand } from '../src/hook-command.js'

// Every subcommand init has written (decision H2 dropped the matcher's own
// allow-list; these stay as fixtures, not as the rule).
const PLUR_SETTINGS_SUBCOMMANDS = [
  'hook-inject', 'hook-observe', 'hook-learn-check', 'hook-session-remind',
  'hook-session-guard', 'hook-session-mark', 'hook-session-end', 'hook-auto-rate',
] as const

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
    [`C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd ${sub}`, true],
  ]),
  ['/home/u/.plur/bin/plur-hook hook-inject --rehydrate', true],
  ['C:\\USERS\\U\\.PLUR\\BIN\\PLUR-HOOK.CMD HOOK-INJECT --rehydrate', true],
  ['plur-hook hook-observe --post', true],
  // Decision H2 "prefix": any hook-* behind PLUR's launcher is PLUR's.
  ['npx @plur-ai/cli hook-auto-rate-mine', true],
]

const THEIRS: Array<[string, boolean]> = [
  ['npx @plur-ai/cli doctor >> ~/log', false],
  ['pwsh ~/.plur/bin/plur-hook-backup.ps1 hook-inject', false],
  ['C:\\Users\\U\\.plur\\bin\\plur-hook-backup.ps1 hook-inject', false],
  ['/home/u/.plur/bin/plur-hook status', false],
  ['/home/u/.plur/bin/my-plur-hook hook-inject', false],
  ['echo @plur-ai/cli-extra hook-inject', false],
  ['echo compacted', false],
]

const CASES = [...OURS, ...THEIRS]

describe('isPlurHookCommand', () => {
  for (const [command, expected] of CASES) {
    it(`${expected ? 'claims' : 'leaves'} ${command}`, () => {
      expect(isPlurHookCommand(command)).toBe(expected)
    })
  }
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
