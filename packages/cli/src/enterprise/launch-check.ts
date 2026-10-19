import type { ExecFn } from './exec.js'

// Minimal launch description — will be replaced by wire.ts's LaunchConfig when Task 5 lands.
export type LaunchConfig = { command: string; args: string[]; env: NodeJS.ProcessEnv }

// The shared exec type (env, timeout and stdin) lives in exec.ts with the real adapter.
export type { ExecFn }

const NPX_NAMES = new Set(['npx', 'npx.cmd', 'npx.exe'])

/**
 * Returns true when the launch runs through npx rather than a pinned binary.
 * Each word of the command and its args is checked by basename, case-
 * insensitively, with both separators — this covers `npx`, an absolute
 * `/opt/homebrew/bin/npx` or `C:\…\npx.cmd`, `cmd.exe /c npx …` and the
 * `/bin/sh -lc 'exec npx -y …'` form `plur init` writes as its fallback.
 */
export function isNpxLaunch(launch: LaunchConfig): boolean {
  return [launch.command, ...launch.args]
    .flatMap(a => a.split(/\s+/))
    .some(word => {
      const base = word.split(/[\\/]/).pop() ?? ''
      return NPX_NAMES.has(base.toLowerCase())
    })
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
