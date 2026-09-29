/**
 * The hook matcher `plur-mcp init` uses to see whether PLUR's Claude Code
 * hooks are already installed, so it never adds a second set next to the
 * ones `plur init` wrote. A copy of @plur-ai/cli's matcher: this package
 * cannot import the CLI.
 */

// BEGIN shared hook matcher — packages/mcp/src/hook-command.ts keeps a
// byte-identical copy of this region (the mcp package cannot import the
// CLI); test/hook-decisions-h2-h3.test.ts fails when they drift.

/**
 * The matcher is anchored (decision F4): the WHOLE command must be PLUR's
 * launcher, then a `hook-*` subcommand, then nothing but plain arguments.
 * A chained, piped, redirected or wrapped command (`&&`, `;`, `|`, `>`,
 * backticks, `$(`, a leading `echo`/`nice`/`env`) is the user's, even when
 * it mentions the shim. The one prefix allowed is PowerShell's `& `, which
 * init itself writes (decision H3's no-short-name fallback).
 */

/** A path or argument character: no whitespace, quote or shell metacharacter. */
const PLAIN = '[^\\s"\'`$&;|<>()]'

/**
 * A PLUR hook subcommand — any `hook-*` (decision H2 "prefix"), so a new hook
 * needs no list update — then only plain arguments to the end.
 */
const HOOK_TAIL = `\\s+hook-[a-z0-9][a-z0-9-]*(?:\\s+${PLAIN}+)*\\s*$`

/**
 * The shim's file name: `plur-hook` or `plur-hook.cmd`, or its Windows 8.3
 * alias. On a spaced home with short names (the default on C:), decision H3
 * writes the short path and the file name is shortened too:
 * `C:/Users/RUNNER~1/.../PLUR~1/bin/PLUR-H~1.CMD`. The alias (`plur-h~<n>.cmd`)
 * is claimed only inside PLUR's own bin directory (`.plur/bin/` or its alias
 * `plur~<n>/bin/`), so another file that shortens to the same name elsewhere
 * stays the user's.
 */
const SHIM_FILE = '(?:plur-hook(?:\\.cmd)?|(?<=/(?:\\.plur|plur~\\d+)/bin/)plur-h~\\d+\\.cmd)'

/**
 * The shim path in every form init has written:
 *  - unquoted, no whitespace (darwin/linux, and Windows short or space-free paths);
 *  - quoted, any characters but a quote (a path with whitespace);
 *  - unquoted with spaces — what versions before #1267 wrote on Windows, and
 *    the Antigravity fallback of decision H3. Only an absolute path ending in
 *    PLUR's own `.plur/bin/` directory, and never with a second absolute path
 *    after a space, so `echo <shim>` or `/usr/bin/env <shim>` never parses
 *    as a path.
 */
const SPACED_CHAR = `(?:(?!\\s+(?:[a-z]:)?/)[^"'\`$&;|<>()])`
const SHIM_PATH = [
  `(?:${PLAIN}*/)?${SHIM_FILE}`,
  `"(?:[^"]*/)?${SHIM_FILE}"`,
  `(?:[a-z]:)?/${SPACED_CHAR}*/\\.plur/bin/${SHIM_FILE}`,
].join('|')

const SHIM_FORM = new RegExp(`^(?:&\\s+)?(?:${SHIM_PATH})${HOOK_TAIL}`)

/** The `npx [-y] @plur-ai/cli[@version] hook-*` fallback, in every form init wrote. */
const NPX_FORM = new RegExp(`^npx(?:\\s+-y)?\\s+@plur-ai/cli(?:@${PLAIN}+)?${HOOK_TAIL}`)

/**
 * Is this hook command one PLUR wrote? The whole command must be PLUR's own
 * launcher (the plur-hook shim in any slash, quote or case form, or the
 * `npx @plur-ai/cli` fallback) followed by any `hook-*` subcommand (decision
 * H2) and plain arguments only (decision F4). A hook run by any other binary
 * is the user's, whatever its subcommand is called, and so is a look-alike
 * such as `plur-hook-backup.ps1`.
 */
export function isPlurHookCommand(command: string): boolean {
  const normalised = command.trim().replace(/\\/g, '/').toLowerCase()
  return SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)
}

// END shared hook matcher
