/**
 * The offline switch: when the machine is declared offline, PLUR starts no
 * network call of its own: the npm update check (which otherwise runs once at
 * start and stops for good when it cannot connect, see version-check.ts) and
 * the model download. A service the user configured by hand (a team server, an
 * OpenAI embedder, a pack URL) is still contacted when the user uses it.
 *
 * Apart from that one update check, PLUR never probes for whether it is
 * online. The environment can say "offline" up front, so not even that one
 * attempt is made:
 *
 *   - PLUR_OFFLINE=1 — PLUR's own switch.
 *   - HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 — the offline conventions PLUR
 *     already honours for the embedding model. Someone who set them has told
 *     their tools the machine is offline, so PLUR does not reach the npm
 *     registry either.
 *
 * The update check alone can also be turned off with PLUR_NO_UPDATE_CHECK=1,
 * or NO_UPDATE_NOTIFIER=1 (the convention npm's own update notifier uses).
 *
 * When that one update check cannot connect, the process is offline from then
 * on (owner decision 2026-10-19, TEAM-5): the state is kept here, not in the
 * update checker, so every network call PLUR starts on its own (the update
 * check, the model download) stops, as if the environment had said "offline".
 * A model already on disk is still used. Services the user configured (team
 * stores, remote embedders, pack URLs, telemetry, a reranker) do not read it.
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
