import { embed } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'

/**
 * Hidden subcommand: spawn-target for `plur doctor`'s embedder probe. Runs in a
 * subprocess because onnxruntime-node can SIGABRT on macOS at exit, which would
 * otherwise make doctor itself exit 134. Contract: writes one line of JSON
 * (shape of DoctorReport's `embedder` field) to stdout and exits 0; a non-zero
 * exit makes the parent report the embedder as degraded.
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
    let modelLoaded = false
    if (!preStatus.disabled) {
      plur.resetEmbedder()
      try {
        // A recall against a missing model deliberately uses keyword search.
        // Doctor is the explicit download path, so await an embedding directly.
        // Core still enforces offline/download-disabled settings.
        const vector = await embed('plur doctor probe', 'query')
        modelLoaded = vector !== null && vector.length > 0
      } catch { /* failure is reported as modelLoaded: false */ }
    }
    const status = plur.embedderStatus()
    process.stdout.write(JSON.stringify({
      available: status.available,
      loaded: status.loaded,
      lastError: status.lastError,
      modelLoaded,
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
