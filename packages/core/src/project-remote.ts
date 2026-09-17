/**
 * One place that decides whether a project's `.plur.yaml` may route this
 * session's prompt text to the host it names (#1198, carrying #1196's gate;
 * hoisted here from the CLI by #1207).
 *
 * Two bugs met here, and the fix for one is the trap for the other.
 *
 * #1196: `hook-inject` adopted `.plur.yaml`'s `remote_url`/`remote_token`
 * unchecked. Both come from the file, so a cloned repository supplied the
 * destination AND the credential, and every prompt was POSTed to a host the
 * repo chose. That is now gated on an explicit `plur trust <dir>`.
 *
 * #1198: every OTHER integration — the two codex hooks, cursor, antigravity,
 * and by extension hermes through `plur inject` — read `.plur.yaml` for `scope`
 * and dropped the remote fields, so PLUR Enterprise team memory silently never
 * arrived. `hook-inject` was the only consumer of `remote_project` in the whole
 * codebase.
 *
 * Closing #1198 by copying hook-inject's old block into six more adapters would
 * have reproduced #1196 in six more places. So the gate travels WITH the
 * capability: an adapter calls this and either gets a remote config it may use,
 * or a refusal it must surface — it cannot get the first without the second
 * having been considered.
 *
 * #1207 is why this lives in core rather than in the CLI. `@plur-ai/opencode`
 * is an adapter that cannot import from `@plur-ai/cli`, and the only two ways
 * to give an out-of-package adapter this capability are to move the gate to
 * the layer both depend on, or to copy the block — which is the mistake above.
 * The CLI keeps its `lib/project-remote.ts` module path as a re-export, so no
 * call site moved.
 *
 * `scope` and `domain` are deliberately NOT gated here. They are local
 * visibility filters that send nothing anywhere, so a project using
 * `.plur.yaml` purely for scoping is unaffected by any of this. (An adapter
 * may still gate them for its own reasons — the opencode plugin does, D2 of
 * its 2026-09 audit, because a scope can name a store that is already
 * registered remotely.)
 */
import { dirname } from 'path'
import { findProjectConfigPath, readProjectConfigFromPath, type ProjectConfig } from './project-config.js'
import type { RemoteProjectConfig } from './types.js'

/** Just the bit of Plur this needs — keeps the helper testable without a store. */
export interface TrustChecker {
  isDirectoryTrusted(dir: string): boolean
}

export interface ProjectRemote {
  /** The project config, whether or not its remote fields were adopted. */
  config: ProjectConfig
  /** Directory the `.plur.yaml` was read from; `null` when there is none. */
  configDir: string | null
  /**
   * The remote config to pass as `remote_project`, or `null` when the project
   * declares none or declares one from an untrusted directory.
   */
  remoteProject: RemoteProjectConfig | null
  /**
   * Set when the project DID declare remote settings and they were refused.
   * Callers must surface this: a remote leg that stops working without
   * explanation is indistinguishable from one that is broken.
   */
  refusedFrom: string | null
}

/**
 * Decide whether an ALREADY-READ project config's remote settings may be used.
 *
 * For callers that resolved the `.plur.yaml` path themselves and read from
 * that resolved path — the opencode plugin does, because it adopts
 * `scope`/`domain` from the same read and a second walk would be a TOCTOU
 * between the file trust is checked against and the file whose fields are
 * adopted. Callers with no path in hand want `resolveProjectRemote` below.
 *
 * Fails CLOSED: any error checking trust drops the remote leg rather than
 * dialing. The trust check runs only when the remote fields are actually
 * present, so a project without them pays nothing.
 */
export function resolveProjectRemoteFromConfig(
  plur: TrustChecker,
  config: ProjectConfig,
  configPath: string | null,
): ProjectRemote {
  const configDir = configPath ? dirname(configPath) : null

  if (!config.remote_url || !config.remote_token) {
    return { config, configDir, remoteProject: null, refusedFrom: null }
  }

  let trusted = false
  try {
    trusted = configDir !== null && plur.isDirectoryTrusted(configDir)
  } catch {
    trusted = false
  }
  if (!trusted) {
    return { config, configDir, remoteProject: null, refusedFrom: configDir ?? '(unknown directory)' }
  }

  return {
    config,
    configDir,
    remoteProject: {
      url: config.remote_url,
      token: config.remote_token,
      ...(config.remote_scopes && config.remote_scopes.length > 0 ? { scopes: config.remote_scopes } : {}),
    },
    refusedFrom: null,
  }
}

/**
 * Resolve the project config and decide whether its remote settings may be used.
 *
 * The path is resolved ONCE and read from, rather than walking twice — two
 * independent walks are a TOCTOU between the file read and the directory
 * trust-checked, which is the assumption the whole gate rests on.
 */
export function resolveProjectRemote(plur: TrustChecker, startDir?: string): ProjectRemote {
  const configPath = startDir ? findProjectConfigPath(startDir) : findProjectConfigPath()
  const config = readProjectConfigFromPath(configPath)
  return resolveProjectRemoteFromConfig(plur, config, configPath)
}

/**
 * The line an adapter shows when remote settings were refused. One wording
 * everywhere, and it always names the directory and the command — a user must
 * never have to guess why recall went quiet.
 */
export function projectRemoteRefusalNotice(refusedFrom: string): string {
  return (
    `[PLUR] Ignored remote memory settings in this project's .plur.yaml — ` +
    `${refusedFrom} is not a trusted directory, and those settings would send ` +
    `prompt text to the host they name. If this project is yours, run: plur trust ${refusedFrom}`
  )
}
