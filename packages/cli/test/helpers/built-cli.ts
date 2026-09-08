/**
 * Resolve the built CLI entrypoint, and refuse to hand back a stale one.
 *
 * The suites here drive a real binary — `spawn('node', [CLI, ...])` against
 * `packages/cli/dist/index.js`. Nothing tied that artifact to the source it was
 * built from, so a `dist` older than `src` produced a full suite of ordinary
 * assertion failures describing behaviour no current code has.
 *
 * Observed 2026-09-07: 14 failures across `forget-namespaced.test.ts`
 * ("Engram not found", "Unexpected end of JSON input") after a PR changed
 * `src/commands/forget.ts`. CI was green throughout, because CI builds before
 * it tests. Three wrong hypotheses were chased — a bad merge, environment
 * leakage from `~/.plur`, a broken test fixture — before the answer turned out
 * to be a `dist` built an hour earlier.
 *
 * A `pretest` build fixes the `npm test` path, and is wired up alongside this.
 * It does NOT fix the path that actually failed: running `npx vitest run
 * <file>` directly, which is what anyone does while iterating on one suite and
 * which skips lifecycle scripts entirely. Hence the runtime assertion — it
 * fires however the suite was invoked.
 *
 * The check is deliberately loud and specific: a stale build should say so, not
 * present as a behavioural difference in the code under test.
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/** Newest mtime under `dir`, recursively. 0 when the directory is absent. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full))
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

/**
 * Path to the built CLI, asserted fresh against `src/`.
 *
 * @param pkgRoot  package root (the directory holding `src/` and `dist/`)
 * @throws when `dist/index.js` is missing or older than the newest source file
 */
export function builtCliPath(pkgRoot: string): string {
  const cli = join(pkgRoot, 'dist', 'index.js')

  if (!existsSync(cli)) {
    throw new Error(
      `Built CLI not found at ${cli}.\n` +
      'These tests spawn the real binary. Run `npm run build` in this package first.',
    )
  }

  const builtAt = statSync(cli).mtimeMs
  const sourcedAt = newestMtime(join(pkgRoot, 'src'))

  // One second of slack: tsup writes dist while src mtimes are already settled,
  // but a same-second rebuild should not be called stale on a coarse filesystem.
  if (sourcedAt > builtAt + 1000) {
    const behindBy = Math.round((sourcedAt - builtAt) / 1000)
    throw new Error(
      `STALE BUILD: ${cli} is ${behindBy}s older than the newest file in src/.\n` +
      'These tests spawn the built binary, so they are exercising code you have already changed.\n' +
      'Any failure below would describe the OLD build, not your work. Run `npm run build` and re-run.',
    )
  }

  return cli
}
