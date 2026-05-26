import { createPlur, type GlobalFlags } from '../plur.js'

/**
 * Hidden subcommand: spawn-target for `plur doctor`'s embedder probe.
 *
 * Why this exists: onnxruntime-node has a known SIGABRT crash on macOS during
 * thread pool cleanup on process exit (issue #197). When that happens in the
 * doctor process itself, doctor exits with code 134 even though everything else
 * is healthy. Running the probe in a subprocess isolates the crash — the
 * subprocess dies, parent stays alive, doctor reports embedder status
 * gracefully and exits with the correct overall code.
 *
 * Contract: writes a single line of JSON to stdout, then exits 0. If the
 * underlying probe crashes (SIGABRT, OOM, etc.) the parent detects the
 * non-zero exit code and reports the embedder as degraded.
 *
 * JSON shape matches the `embedder` field of DoctorReport.
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  // Refuse to run when not invoked by the parent `plur doctor` process.
  // This is checked first so that curious users discovering the command
  // (e.g. via tab-complete) get a clear message instead of opaque JSON.
  if (process.env.PLUR_INTERNAL_PROBE !== '1') {
    process.stderr.write(
      '_embedder-probe is an internal subcommand spawned by `plur doctor`. ' +
      'Run `plur doctor` instead.\n',
    )
    process.exit(1)
  }

  try {
    const plur = createPlur(flags)
    const preStatus = plur.embedderStatus()
    if (!preStatus.disabled) {
      plur.resetEmbedder()
      try {
        await plur.recallSemantic('plur doctor probe', { limit: 1 })
      } catch { /* best effort — probe completing is enough signal */ }
    }
    const status = plur.embedderStatus()
    process.stdout.write(JSON.stringify({
      available: status.available,
      loaded: status.loaded,
      lastError: status.lastError,
      modelLoaded: status.available && status.loaded,
      disabled: status.disabled,
      disabledReason: status.disabledReason,
    }) + '\n')
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({
      available: false,
      loaded: false,
      lastError: err instanceof Error ? err.message : String(err),
      modelLoaded: false,
      disabled: false,
      disabledReason: null,
    }) + '\n')
    process.exit(0)
  }
}
