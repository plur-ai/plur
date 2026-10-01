/**
 * `remote-only` folders (owner decisions 2026-10-01): what a Plur instance
 * bound to such a folder refuses, and how it says so.
 *
 * The folder's memory lives only on the team server, in one scope. A write
 * with no scope goes there (that scope is the folder's "global"); a write to
 * another shared scope served by a url store the user can write still works;
 * everything that would stay on this machine — a personal scope (`user:`,
 * `agent:`, `global`, `local`), a local-only scope (`project:` and other
 * scopes no url store serves), a private write, or content the sensitivity
 * guard would demote to local — is refused, with nothing written or sent.
 */

/** A Plur instance's binding to a remote-only folder. */
export interface RemoteOnlyBinding {
  /** The folder the instance was bound to. */
  folder: string
  /** The folder's team scope; null when the map entry names none. */
  scope: string | null
  /**
   * Set when the folder map could not be read (`reason: 'malformed-map'`):
   * why, naming the file. The instance then reads and writes nothing at all
   * (audit of #1521, S3: fail safe, never fall back to `on`).
   */
  blocked?: string
}

/**
 * Whether the folder's team server answered, as reported on an injection
 * (`InjectionResult.remote_only`). `served: false` means the session has no
 * memory from it this time, and says why.
 */
export interface RemoteOnlyStatus {
  folder: string
  scope: string | null
  served: boolean
  /** The team server's host, when one serves the scope. */
  host?: string
  /**
   * Why it was not served: `no-scope` (the entry names none), `no-store` (no
   * writable url store serves the scope), `disabled` (PLUR_REMOTE_RECALL is
   * off), or the remote host state (`timeout`, `unreachable`, `auth_expired`,
   * `forbidden`, `rate_limited`, `unsupported`, `skipped_cooldown`).
   */
  reason?: string
}

export type RemoteOnlyRefusal =
  | 'personal-scope' | 'local-only-scope' | 'private' | 'sensitive' | 'no-store' | 'no-scope' | 'timeline'
  /** An operation on a row kept in this machine's store (personal, or a save waiting to be sent). */
  | 'local-row'
  /** A queued save from a remote-only folder may only be delivered or deleted. */
  | 'queued-stays-remote'
  /** An operation that reads or writes the personal store as a whole (meta-engrams, export, tensions). */
  | 'local-store'
  /** The folder map could not be read; nothing is read or written. */
  | 'blocked'

export class RemoteOnlyWriteError extends Error {
  readonly code = 'remote-only'
  constructor(
    public readonly folder: string,
    public readonly scope: string | null,
    public readonly requested: string | undefined,
    public readonly refusal: RemoteOnlyRefusal,
    detail?: string,
  ) {
    super(remoteOnlyRefusalMessage(folder, scope, requested, refusal, detail))
    this.name = 'RemoteOnlyWriteError'
  }
}

function quote(p: string): string {
  return /^[A-Za-z0-9_./~:@-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, '\\$1')}"`
}

export function remoteOnlyRefusalMessage(
  folder: string, scope: string | null, requested: string | undefined, refusal: RemoteOnlyRefusal, detail?: string,
): string {
  if (refusal === 'blocked') {
    return `PLUR reads and writes nothing in ${folder}: ${detail ?? 'the folder map could not be read'}. ` +
      'Fix or remove that file (every folder behaves like ask until then).'
  }
  if (refusal === 'queued-stays-remote') {
    return `${detail ?? 'This memory'} is a save from the remote-only folder ${folder}, waiting to be sent to the team ` +
      `server${scope ? ` (scope "${scope}")` : ''}. It can only be delivered (to a team scope) or forgotten, never ` +
      'kept on this machine, so nothing was changed.'
  }
  const where = scope
    ? `This folder (${folder}) is remote-only: its memory lives only on the team server, in scope "${scope}".`
    : `This folder (${folder}) is remote-only, but its folder-map entry names no team scope.`
  const why: Record<RemoteOnlyRefusal, string> = {
    'personal-scope': `"${requested}" is a personal scope, which stays on this machine, so nothing was saved.`,
    'local-only-scope': `"${requested}" is not served by a team server you can write to, so it would stay on this machine; nothing was saved.`,
    private: 'A private memory stays on this machine, so nothing was saved.',
    sensitive: `The content looks sensitive (${detail ?? 'a sensitive pattern'}); outside a remote-only folder it would be kept locally, which this folder does not allow, so nothing was saved.`,
    'no-store': `No writable team store for "${requested ?? scope}" is configured in config.yaml, so nothing was saved.`,
    'no-scope': 'Nothing was saved.',
    'local-row': `${detail ?? 'That operation'} works only on team memories here; that memory is kept on this machine (a personal memory, or a save still waiting to be sent), so nothing was changed.`,
    blocked: '', // handled above
    'queued-stays-remote': '', // handled above
    'local-store': `${detail ?? 'That operation'} reads or writes this machine's personal store, which a remote-only folder does not use, so nothing was done.`,
    timeline: 'The session timeline (episodes) is kept on this machine and can hold session content, so nothing is captured here.',
  }
  const fix = refusal === 'personal-scope' || refusal === 'local-only-scope' || refusal === 'private'
    ? scope ? ` Save it without a scope (it goes to "${scope}") or to another team scope.` : ''
    : ''
  const change = ` To keep memory on this machine here instead, change the folder: plur folders set ${quote(folder)} --on ` +
    `(or plur folders rm ${quote(folder)}).`
  return `${where} ${why[refusal]}${fix}${change}`
}

/** The line a session shows once when the folder's team server did not answer. */
export function remoteOnlyUnservedNotice(status: RemoteOnlyStatus): string {
  const host = status.host ? ` (${status.host})` : ''
  if (status.reason === 'no-scope' || status.reason === 'no-store') {
    return `[PLUR Memory — remote-only folder: no team server serves ${status.scope ? `"${status.scope}"` : 'this folder'}` +
      ` (${status.reason}), so this session starts without memory. Fix the folder entry with plur folders set.]`
  }
  return `[PLUR Memory — remote-only folder: the team server${host} could not be reached (${status.reason ?? 'unknown'}), ` +
    'so this session starts without memory. Memories you save here are queued and sent when it is back; ' +
    'nothing is read from or kept in your personal store.]'
}

/** The line a remote-only session shows at its start, telling the agent where memory goes. */
export function remoteOnlySessionLine(binding: RemoteOnlyBinding): string {
  if (binding.blocked) return `[PLUR Memory — off here: ${binding.blocked}. Nothing is read or saved until it is fixed.]`
  return binding.scope
    ? `This folder is remote-only: memory here lives only on the team server, in scope "${binding.scope}". ` +
      'Call plur_learn without a scope (it goes there) or with another team scope; personal and local scopes are refused here.'
    : 'This folder is remote-only but names no team scope: memory is off here until its entry names one (plur folders set).'
}
