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
 * A PLUR hook subcommand: any `hook-*` (decision H2 "prefix"), so a new hook
 * needs no list update here. It must be a whole word.
 */
const HOOK_SUBCOMMAND = '(?:hook-[a-z0-9][a-z0-9-]*)(?:\\s|$)'

/**
 * The shim as a whole path segment — `plur-hook` or `plur-hook.cmd`, at the
 * start of the command, after a slash or after an opening quote — optionally
 * closed by a quote, then whitespace and a hook subcommand. The path before
 * it may contain spaces: versions before #1267 wrote it unquoted on Windows.
 *
 * Or its Windows 8.3 alias. On a spaced home with short names (the default on
 * C:), decision H3 writes the short path, and the file name is shortened too:
 * `C:/Users/RUNNER~1/.../PLUR~1/bin/PLUR-H~1.CMD hook-inject`. The alias
 * (`plur-h~<n>.cmd`) is claimed only inside PLUR's own bin directory
 * (`.plur/bin/` or its alias `plur~<n>/bin/`), so another file that happens
 * to shorten to the same name elsewhere stays the user's.
 */
const SHIM_FORM = new RegExp(
  `(?:(?:^|[/"])plur-hook(?:\\.cmd)?|/(?:\\.plur|plur~\\d+)/bin/plur-h~\\d+\\.cmd)"?\\s+${HOOK_SUBCOMMAND}`,
)

/** The `npx @plur-ai/cli[@version] hook-*` fallback, in every form init wrote. */
const NPX_FORM = new RegExp(`(?:^|\\s)@plur-ai/cli(?:@\\S+)?\\s+${HOOK_SUBCOMMAND}`)

/**
 * Is this hook command one PLUR wrote? PLUR's own launcher (the plur-hook
 * shim as a whole path segment, in any slash, quote or case form, or the
 * `npx @plur-ai/cli` fallback) immediately followed by any `hook-*`
 * subcommand (decision H2). A hook run by any other binary is the user's,
 * whatever its subcommand is called, and so is a look-alike such as
 * `plur-hook-backup.ps1`.
 */
export function isPlurHookCommand(command: string): boolean {
  const normalised = command.replace(/\\/g, '/').toLowerCase()
  return SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)
}

// END shared hook matcher
