import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname } from 'path'
import { _ownerOnlyHost, checkOwnerOnly, currentWindowsAccount, protectOwnerOnly, type OwnerOnlyExec } from './owner-only.js'


/**
 * Mode for files that carry credentials — `config.yaml` holds remote bearer
 * tokens and Postgres DSNs. Owner-only.
 */
export const CONFIG_FILE_MODE = 0o600


/** Options for {@link atomicWrite}. */
export interface AtomicWriteOptions {
  /**
   * Mode for a file this write CREATES. Ignored when the destination already
   * exists — an existing file's mode is preserved instead, which is the more
 * important half.
   *
   * Pass `0o600` for anything credential-bearing. Without it a new
   * `config.yaml` — bearer tokens, Postgres DSNs — is born world-readable under
   * the default umask, and the preservation path then faithfully keeps it that
   * way forever.
   */
  mode?: number
  /**
   * fsync the file and its parent directory before returning. Default `true`.
   *
   * Pass `false` ONLY for derived, rebuildable state (embedding cache,
   * reranker-eval cache, telemetry counters). Never for a store file: see the
   * durability note on {@link atomicWrite}.
   */
  durable?: boolean
  /**
   * The content may carry a credential. On Windows the temp file is made owner-only and
   * verified before the first byte; the write is refused (destination untouched) when that
   * fails or an existing destination's access list cannot be inspected. A plain owner-only
   * `mode` gets this only over a provably owner-only destination, without refusal.
   * No effect on POSIX, where the destination mode already governs the temp file.
   */
  secret?: boolean
  /**
   * With {@link ALLOW_UNPROTECTED_ENV} set, called (instead of the default
   * stderr line) with the reason when the write goes out without owner-only
   * protection — so a caller that reports on its own (writeConfigFile) prints
   * one line, not two.
   */
  onUnprotected?: (cause: string) => void
}


/** Counter making each tmp name unique within a process (pid makes it unique across them). */
export let tmpCounter = 0


/** One external command run for the Windows access-list path ({@link _atomicWriteAcl}). */
export type AclExec = OwnerOnlyExec


/**
 * Platform, environment and command runner for atomicWrite's Windows owner-only path.
 * Internal; tests swap fields to drive the Windows branch. The SAME object as the
 * `owner-only.ts` host, so one simulated host drives this and `writeConfigFile`'s re-check.
 */
export const _atomicWriteAcl = _ownerOnlyHost


/**
 * What an access-list inspection established.
 * `unknown` — icacls failed, or its output names no account — is NOT the same
 * as `shared`: a credential write must refuse on it rather than go ahead
 * unprotected.
 */
export type AclInspection = 'owner-only' | 'shared' | 'unknown'


/** Inspect `path`: does every access entry name `account` only? */
export function inspectAcl(path: string, account: string): AclInspection {
  const r = checkOwnerOnly(path, { platform: 'win32', account })
  return r.ok === true ? 'owner-only' : r.ok === false ? 'shared' : 'unknown'
}


/**
 * The owner's way out on a drive that cannot keep access lists (FAT/exFAT,
 * some network shares — icacls fails there, so every credential write would
 * be refused and PLUR could not save its config at all). Set to `1` (or
 * `true` / `yes`), a credential write whose owner-only protection cannot be
 * established is written WITHOUT it, with one stderr line saying so, instead
 * of being refused. Unset (the default), it is refused.
 */
export const ALLOW_UNPROTECTED_ENV = 'PLUR_ALLOW_UNPROTECTED_CONFIG'


/** How a refused credential write's error starts. The rest names the cause and the opt-out, never content. */
export const REFUSED_CREDENTIAL_WRITE = 'atomicWrite: refusing a credential write: '


export function allowUnprotected(env: NodeJS.ProcessEnv): boolean {
  const v = env[ALLOW_UNPROTECTED_ENV]?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}


/**
 * A Windows credential write whose protection cannot be established: refused
 * (throws; the message names the cause and the opt-out), or — with
 * {@link ALLOW_UNPROTECTED_ENV} set — reported on stderr and written without
 * the protection (returns).
 */
export function refuseUnprotected(filePath: string, cause: string, onUnprotected?: (cause: string) => void): void {
  if (allowUnprotected(_atomicWriteAcl.env)) {
    if (onUnprotected) onUnprotected(cause)
    else console.error(`[plur:config] writing ${basename(filePath)} WITHOUT owner-only protection (${ALLOW_UNPROTECTED_ENV} is set): ${cause}`)
    return
  }
  throw new Error(`${REFUSED_CREDENTIAL_WRITE}${cause}. Nothing was written. ` +
    `If this drive cannot keep access lists (FAT/exFAT, some network shares), set ${ALLOW_UNPROTECTED_ENV}=1 to write it without that protection.`)
}


/** Make `path` owner-only and verify it; returns why it could not, or null. */
export function protectWindowsOwnerOnly(path: string, account: string | null): string | null {
  if (!account) return 'cannot make the temporary file owner-only: the Windows account is not known (USERNAME is not set)'
  const r = protectOwnerOnly(path, { platform: 'win32', account })
  if (r.ok) return null
  return r.detail.startsWith('icacls failed')
    ? `cannot make the temporary file owner-only: ${r.detail}`
    : `cannot make the temporary file owner-only: its access list still names another account or cannot be read back (${r.detail})`
}


/**
 * Atomic write: write to a unique temp file, fsync, then rename over the target.
 * - fsync by default (and the parent directory too): after power loss a rename can land
 *   before the data, and a zero-length engrams.yaml read as empty would lose the corpus.
 * - Unique tmp names keep concurrent writers independent; the last rename wins cleanly.
 * - The tmp is protected before the first byte: created `wx` at 0600 when a mode is known,
 *   given its final mode just before rename. On Windows a `secret` write gets a verified
 *   owner-only list on the EMPTY tmp, else nothing is written ("could not inspect" is never
 *   "not protected"); an owner-only `mode` write is protected only over an owner-only destination.
 */
export function atomicWrite(filePath: string, content: string | Buffer, opts: AtomicWriteOptions = {}): void {
  const durable = opts.durable !== false
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Preserve the destination's permissions: rename creates a new inode with the tmp's mode
  // (0644 under umask 022), but config.yaml holds tokens and must stay 0600. Read the mode
  // BEFORE writing and apply it to the tmp BEFORE the rename. No destination: platform default.
  let destMode: number | undefined = opts.mode
  const destExists = existsSync(filePath)
  try {
    // An EXISTING file's own mode wins over opts.mode: the operator may have
    // tightened it further, and a write must never loosen what it found.
    if (destExists) destMode = statSync(filePath).mode & 0o7777
  } catch { /* unreadable stat — fall through and keep opts.mode/default */ }

  // Windows keeps access in an inherited ACL, so the rename would publish a file other
  // accounts can read. Ordinary writes never run icacls.
  // - `secret` writes ALWAYS get a verified owner-only list on the EMPTY tmp, or are refused
  //   with nothing written; an uninspectable existing destination is refused too.
  // - Owner-only `mode` writes: protected when the destination is provably owner-only;
  //   an unknown result is not refused.
  let winAccount: string | null = null
  let winProtect = false
  if (_atomicWriteAcl.platform === 'win32') {
    const secret = opts.secret === true
    const credential = secret || (opts.mode !== undefined && (opts.mode & 0o077) === 0)
    if (credential) winAccount = currentWindowsAccount(_atomicWriteAcl.env)
    if (credential && destExists) {
      const inspection: AclInspection = winAccount === null ? 'unknown' : inspectAcl(filePath, winAccount)
      if (inspection === 'unknown' && secret) {
        // Refused (throws) unless the owner opted out. Opted out, the temp file
        // is still protected when it can be; only a failure there (or no known
        // account to protect it for) writes it unprotected, reported.
        if (winAccount === null || !allowUnprotected(_atomicWriteAcl.env)) {
          refuseUnprotected(filePath, winAccount === null
            ? 'cannot tell whether the destination is owner-only (the Windows account is not known: USERNAME is not set)'
            : 'cannot inspect the destination\'s access list (icacls failed or named no account)', opts.onUnprotected)
        }
        winProtect = winAccount !== null
      } else {
        winProtect = inspection === 'owner-only' || secret
      }
    } else if (secret) {
      if (winAccount === null) {
        refuseUnprotected(filePath, 'cannot make the new file owner-only (the Windows account is not known: USERNAME is not set)', opts.onUnprotected)
      } else {
        winProtect = true
      }
    }
  }

  // Create the tmp exclusively, owner-only whenever a mode is known. With no
  // mode to keep the result is the platform default anyway, so the default is
  // used for the tmp too and nothing changes for ordinary files.
  const createMode = destMode === undefined ? 0o666 : 0o600
  let tmp = ''
  let fd: number | undefined
  for (let attempt = 0; fd === undefined; attempt++) {
    tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`
    try {
      fd = openSync(tmp, 'wx', createMode)
    } catch (err) {
      // A stale tmp (or anything planted) at this name: never reuse it, take the next name.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 1000) continue
      throw err
    }
  }
  try {
    try {
      if (winProtect) {
        const failed = protectWindowsOwnerOnly(tmp, winAccount)
        if (failed !== null) refuseUnprotected(filePath, failed, opts.onUnprotected)
      }
      writeFileSync(fd, content)
      if (durable) fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (destMode !== undefined) {
      // Best-effort: a filesystem without POSIX modes (some Windows/network
      // mounts) must not fail an otherwise good write over cosmetics. If it
      // fails the tmp stays at its 0600 creation mode — stricter, never wider.
      try { chmodSync(tmp, destMode) } catch { /* not a mode-bearing filesystem */ }
    }
    renameSync(tmp, filePath)
    if (durable) fsyncDir(dir)
  } catch (err) {
    // Never leave the tmp behind on a failed write — it would accumulate, and
    // with a unique name nothing would ever clean it up. Only a tmp this call
    // created reaches here (an EEXIST name is skipped above, never unlinked).
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw err
  }
}


/**
 * fsync a directory so a rename into it is durable.
 *
 * Best-effort by design: directory fds cannot be opened for sync on Windows,
 * and some filesystems reject the fsync outright. A failure here means the
 * rename may not survive power loss — it does NOT mean the write failed, and
 * throwing would turn a working write into a spurious error.
 */
export function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    /* platform does not support it — the file's own fsync still happened */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}
