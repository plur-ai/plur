/**
 * Shared guard for the CLI test suites that drive the binary via `spawnSync`.
 *
 * `spawnSync` does not throw. When the child times out or cannot be spawned it
 * returns normally with `error` set, `status` null, and whatever partial output
 * it managed to collect. Every hook suite here was reading `result.stdout ?? ''`
 * and dropping `error` on the floor, which turns an infrastructure failure into
 * a content assertion:
 *
 *     const { stdout } = runHook(id)          // timed out, stdout is ''
 *     JSON.parse(stdout).additionalContext    // throws -> recorded as "no nudge"
 *     expect(nudged).toEqual([...])           // reports an off-by-one counter
 *
 * The suite then blames the code under test for an off-by-one it does not have.
 * That is the failure mode this repo keeps paying for: the assertion is honest
 * about the value it saw and silent about the value being meaningless.
 *
 * These suites spawn a cold Node process per assertion — one of them twelve
 * times in a loop — so under a full parallel run they are genuinely the most
 * load-sensitive tests in the repo. The fix is not a longer timeout alone; it
 * is refusing to interpret the output of a process that did not finish.
 */
import { spawnSync } from 'child_process'
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process'

/**
 * Default timeout for a spawned CLI invocation.
 *
 * 10s is comfortable for a warm machine and marginal for a cold Node start on a
 * box already running ~220 test files. Raised deliberately: a timeout here has
 * never once indicated a real defect, only a busy machine.
 */
export const CLI_SPAWN_TIMEOUT = 60_000

/**
 * Assert the child actually ran to completion, and return it unchanged.
 *
 * Throws on spawn failure, timeout, or termination by signal — i.e. exactly the
 * cases where the caller's output is not evidence of anything. A non-zero exit
 * status is NOT an error: several suites assert on failing exits deliberately.
 */
export function assertSpawned(
  result: SpawnSyncReturns<string>,
  what: string,
): SpawnSyncReturns<string> {
  if (result.error) {
    const e = result.error as NodeJS.ErrnoException
    const hint =
      e.code === 'ETIMEDOUT'
        ? ` — exceeded ${CLI_SPAWN_TIMEOUT}ms. The machine is loaded, or the CLI hung.`
        : ''
    throw new Error(
      `${what}: the child process did not run to completion (${e.code ?? e.name}).${hint}\n` +
        `stdout: ${JSON.stringify(result.stdout ?? '')}\n` +
        `stderr: ${JSON.stringify(result.stderr ?? '')}`,
    )
  }
  if (result.signal) {
    throw new Error(
      `${what}: the child process was killed by ${result.signal}.\n` +
        `stdout: ${JSON.stringify(result.stdout ?? '')}\n` +
        `stderr: ${JSON.stringify(result.stderr ?? '')}`,
    )
  }
  return result
}

/**
 * Drop-in replacement for `spawnSync` in these suites: same signature, same
 * return value, but the child is checked before the caller can misread it.
 *
 * The caller's own `timeout` is treated as a floor rather than a ceiling — none
 * of these suites asserts on timeout behaviour, they all just wanted a guard
 * rail against a hang, and the short values they picked are the ones that trip
 * under parallel load.
 */
export function runCli(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const result = spawnSync(cmd, args, {
    ...opts,
    timeout: Math.max(opts.timeout ?? 0, CLI_SPAWN_TIMEOUT),
  })
  return assertSpawned(result, `${cmd} ${args.join(' ')}`)
}
