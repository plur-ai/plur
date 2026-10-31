/**
 * One place that decides whether a project's `.plur.yaml` may route this
 * session's prompt text to the host it names.
 *
 * Both `remote_url` and `remote_token` come from the file, so an untrusted
 * (e.g. cloned) repository could otherwise supply the destination AND the
 * credential and have every prompt POSTed to a host it chose. Remote settings
 * are therefore adopted only from a directory approved with `plur trust <dir>`.
 *
 * Every integration that reads `.plur.yaml` must go through this helper rather
 * than reading the remote fields itself: the gate travels WITH the capability,
 * so an adapter either gets a remote config it may use or a refusal it must
 * surface. It lives in core so adapters that cannot import the CLI can use it;
 * the CLI re-exports it from `lib/project-remote.ts`.
 *
 * `scope` and `domain` are deliberately NOT gated here. They are local
 * visibility filters that send nothing anywhere, so a project using
 * `.plur.yaml` purely for scoping is unaffected. (An adapter may still gate
 * them for its own reasons — e.g. a scope can name a store that is already
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
