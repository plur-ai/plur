import { spawnSync } from 'child_process'

/**
 * Sync exec abstraction shared by every enterprise task (CA lookup, version
 * check, `plur init`). `env`, `timeoutMs` and `input` are all honoured by the
 * real adapter below — an adapter that dropped env would check a different
 * binary than the tool launches, and one that dropped the timeout could hang
 * `init` forever.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; stderr?: boolean }
) => { status: number; stdout: string; stderr?: string }

/** The command ran past `timeoutMs` and was killed (the `timeout(1)` code). */
export const EXEC_TIMEOUT_STATUS = 124
/** Refused before starting: a `.cmd`/`.bat` on Windows. */
export const EXEC_REFUSED_STATUS = 126
/** The command could not be started (ENOENT, EACCES, …). */
export const EXEC_START_FAILED_STATUS = 127
/** Killed by a signal that was not our timeout. */
export const EXEC_SIGNALLED_STATUS = 128

const WINDOWS_BATCH = /\.(cmd|bat)$/i

/**
 * The real adapter: `spawnSync` with an argument array and no shell.
 *
 * - A timeout (spawnSync reports `status: null`) becomes a non-zero status, so
 *   no caller can read a killed command as a success.
 * - A command that cannot start becomes a status, never a throw.
 * - On Windows a `.cmd`/`.bat` is refused: spawnSync without a shell fails
 *   with EINVAL there, and running it through `cmd.exe` would re-parse every
 *   argument. Callers resolve a real executable instead.
 */
export function createExec(platform: NodeJS.Platform = process.platform): ExecFn {
  return (cmd, args, opts = {}) => {
    if (platform === 'win32' && WINDOWS_BATCH.test(cmd)) {
      return { status: EXEC_REFUSED_STATUS, stdout: '' }
    }
    let r: ReturnType<typeof spawnSync>
    try {
      r = spawnSync(cmd, args, {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        env: opts.env,
        timeout: opts.timeoutMs,
        // SIGTERM can be caught or ignored, and spawnSync then waits on: the
        // timeout would bound nothing. SIGKILL cannot be.
        killSignal: 'SIGKILL',
        input: opts.input,
        // stderr only when asked (a log of `plur init`): a probe never reads it.
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', opts.stderr ? 'pipe' : 'ignore'],
        // A Windows or macOS certificate export runs to a few MB.
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch {
      // Rejected before anything started (a NUL in an argument, a bad
      // option): a start failure, never a throw past the adapter.
      return { status: EXEC_START_FAILED_STATUS, stdout: '' }
    }
    const stdout = typeof r.stdout === 'string' ? r.stdout : ''
    const out = outcome(r, stdout)
    return opts.stderr ? { ...out, stderr: typeof r.stderr === 'string' ? r.stderr : '' } : out
  }
}

/** spawnSync's result as a status: timeout, start failure and signal each get their own code. */
function outcome(r: ReturnType<typeof spawnSync>, stdout: string): { status: number; stdout: string } {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT') return { status: EXEC_TIMEOUT_STATUS, stdout }
  if (r.error && r.pid === 0) return { status: EXEC_START_FAILED_STATUS, stdout: '' }
  if (r.error) return { status: code === 'ENOENT' ? EXEC_START_FAILED_STATUS : EXEC_SIGNALLED_STATUS, stdout }
  if (r.status === null) return { status: EXEC_SIGNALLED_STATUS, stdout }
  return { status: r.status, stdout }
}

export const realExec: ExecFn = createExec()
