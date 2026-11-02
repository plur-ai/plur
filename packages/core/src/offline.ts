/**
 * The offline switch: when offline, PLUR starts no network activity of its own (the npm
 * update check, model downloads); services the user configured are still contacted on use.
 * - PLUR_OFFLINE=1, or HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1, declares offline up front.
 * - PLUR_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER=1 disables only the update check.
 * - If the update check cannot connect, the process is offline from then on (state lives
 *   here). Models on disk are still used. Every automatic model download goes through
 *   refuseMissingModelOffline (embedders/transformers-base.ts), which reads offlineNow().
 */

const truthy = (v: string | undefined): boolean =>
  !!v && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())

/** True when the environment declares this machine offline. */
export function offlineByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.PLUR_OFFLINE) || truthy(env.HF_HUB_OFFLINE) || truthy(env.TRANSFORMERS_OFFLINE)
}

/** True when the npm update check must not run: offline, or turned off. */
export function updateCheckDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return offlineByEnv(env) || truthy(env.PLUR_NO_UPDATE_CHECK) || truthy(env.NO_UPDATE_NOTIFIER)
}

/** Set when a network attempt PLUR made on its own could not connect. */
let inferred = false

/** Mark this process offline: a connection PLUR started on its own failed. */
export function markOffline(): void {
  inferred = true
}

/** True once this process has inferred it is offline (see markOffline). */
export function offlineInferred(): boolean {
  return inferred
}

/** True when PLUR must start no network call of its own: declared offline by
 *  the environment, or inferred offline from a failed connection. */
export function offlineNow(env: NodeJS.ProcessEnv = process.env): boolean {
  return inferred || offlineByEnv(env)
}

/** Forget the inferred offline state. Test-only. */
export function _resetInferredOffline(): void {
  inferred = false
}
