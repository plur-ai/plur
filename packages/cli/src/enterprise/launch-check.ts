// Minimal launch description — will be replaced by wire.ts's LaunchConfig when Task 5 lands.
export type LaunchConfig = { command: string; args: string[]; env: NodeJS.ProcessEnv }

// Sync exec abstraction — matches the shape used across enterprise tasks.
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }
) => { status: number; stdout: string }

/** Returns true when the launch runs through npx rather than a pinned binary. */
function isNpxLaunch(launch: LaunchConfig): boolean {
  return [launch.command, ...launch.args].some(a => a === 'npx' || a.endsWith('npx.cmd'))
}

/**
 * Checks that the binary a tool launches reports the expected PLUR version.
 * Runs `command ...args --version` with the tool's own env and a 15 s timeout.
 */
export function checkLaunchVersion(
  label: string,
  launch: LaunchConfig,
  expected: string,
  exec: ExecFn
): { ok: true } | { ok: false; reported: string | null; detail: string } {
  if (isNpxLaunch(launch)) {
    return {
      ok: false,
      reported: null,
      detail: `${label} launches PLUR through npx — re-run \`plur init\` after installing @plur-ai/mcp`,
    }
  }

  const result = exec(launch.command, [...launch.args, '--version'], {
    env: launch.env,
    timeoutMs: 15_000,
  })

  if (result.status !== 0) {
    return {
      ok: false,
      reported: null,
      detail: `could not start ${label} (exit ${result.status})`,
    }
  }

  const reported = result.stdout.trim()
  if (reported === expected) {
    return { ok: true }
  }

  return {
    ok: false,
    reported,
    detail: `${label} launches PLUR ${reported}, expected ${expected}`,
  }
}
