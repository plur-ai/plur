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
