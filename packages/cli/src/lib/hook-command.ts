import { platform } from 'os'

/**
 * The command prefix every PLUR hook entry starts with, given the shim path
 * `plur init` installed (#1267).
 *
 * Harnesses run hook commands through a shell, so an unquoted path splits at
 * the first space: `C:\Users\Test User\.plur\bin\plur-hook.cmd hook-inject`
 * becomes the command `C:\Users\Test`. Windows home directories contain
 * spaces often enough that the path is always quoted there. Elsewhere it is
 * quoted only when it contains whitespace, so a darwin/linux path without
 * one stays byte-identical to what earlier versions wrote.
 */
export function hookCommandPrefix(binPath: string, plat: NodeJS.Platform = platform()): string {
  if (plat === 'win32' || /\s/.test(binPath)) return `"${binPath}"`
  return binPath
}

/**
 * The exact subcommands `plur init` has ever written into a Claude Code
 * settings.json (every version since the first, including the
 * `npx @plur-ai/cli` era). A hook naming PLUR's binary with any other
 * argument is not one init wrote, so init must not remove it.
 */
const PLUR_SETTINGS_SUBCOMMANDS = [
  'hook-inject',
  'hook-observe',
  'hook-learn-check',
  'hook-session-remind',
  'hook-session-guard',
  'hook-session-mark',
  'hook-session-end',
  // #1310: the Stop-hook auto-rater, written by init since that PR.
  'hook-auto-rate',
]

const SUBCOMMAND = `(?:${PLUR_SETTINGS_SUBCOMMANDS.join('|')})(?:\\s|$)`

/**
 * The shim as a whole path segment — `plur-hook` or `plur-hook.cmd`, at the
 * start of the command, after a slash or after an opening quote — optionally
 * closed by a quote, then whitespace and a known subcommand. The path before
 * it may contain spaces: versions before #1267 wrote it unquoted on Windows.
 */
const SHIM_FORM = new RegExp(`(?:^|[/"])plur-hook(?:\\.cmd)?"?\\s+${SUBCOMMAND}`)

/** The `npx @plur-ai/cli[@version] hook-*` fallback, in every form init wrote. */
const NPX_FORM = new RegExp(`(?:^|\\s)@plur-ai/cli(?:@\\S+)?\\s+${SUBCOMMAND}`)

/**
 * Is this hook command one PLUR wrote? A two-part test, the same one
 * `isPlurCursorHookEntry` and `isPlurCodexHookSpec` apply: the PLUR binary
 * (the shim as a whole path segment, or the `npx @plur-ai/cli` fallback)
 * immediately followed by one of the exact subcommands init writes.
 *
 * Slashes are normalised and the test is case-insensitive, because Windows
 * paths are (#1267): before, the match was a forward-slash substring, so a
 * re-run of `plur init` on Windows did not see its own backslash hooks and
 * appended a second set. A bare substring test is not enough either: it
 * claimed a user's own `~/.plur/bin/plur-hook-backup.ps1`.
 */
export function isPlurHookCommand(command: string): boolean {
  const normalised = command.replace(/\\/g, '/').toLowerCase()
  return SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)
}
