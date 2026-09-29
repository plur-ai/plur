/**
 * Recognise the hook commands PLUR writes into a Claude Code settings.json.
 *
 * A faithful copy of `isPlurHookCommand` in @plur-ai/cli's
 * `src/lib/hook-command.ts` (#1270), which this package cannot import. Keep
 * the two identical: test/hook-command.test.ts runs the same cases against
 * the cli's copy whenever that file is present in the workspace.
 *
 * Pure and free of side effects, so tests can import it without loading the
 * `plur-mcp` bin entry.
 */

/**
 * The exact subcommands `plur init` and `plur-mcp init` have ever written into
 * a Claude Code settings.json (every version since the first, including the
 * `npx @plur-ai/cli` era). A hook naming PLUR's binary with any other argument
 * is not one init wrote, so init must not remove it.
 */
export const PLUR_SETTINGS_SUBCOMMANDS = [
  'hook-inject',
  'hook-observe',
  'hook-learn-check',
  'hook-session-remind',
  'hook-session-guard',
  'hook-session-mark',
  'hook-session-end',
  // #1310: kept identical to the cli copy, which lists it since #1318.
  'hook-auto-rate',
] as const

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
 * Is this hook command one PLUR wrote? A two-part test: the PLUR binary (the
 * shim as a whole path segment, or the `npx @plur-ai/cli` fallback)
 * immediately followed by one of the exact subcommands init writes.
 *
 * Backslashes are normalised to `/` and the test is case-insensitive, because
 * Windows paths are: a forward-slash substring test never matched the
 * backslash shim path, so a re-run of `plur-mcp init` on Windows appended a
 * second hook set (#1303). A bare substring test is not enough either: it
 * claimed a user's own `~/.plur/bin/plur-hook-backup.ps1` or
 * `npx @plur-ai/cli doctor`.
 */
export function isPlurHookCommand(command: string): boolean {
  const normalised = command.replace(/\\/g, '/').toLowerCase()
  return SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)
}
