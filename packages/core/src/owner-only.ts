import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { chmodSync, readFileSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Owner-only protection for files (and folders) that hold a secret (#1631,
 * plan B Task 1b; audit finding 2). One rule for every caller — core's
 * config.yaml writes, atomicWrite's temporary files, the enterprise
 * installer's backups and key file:
 *
 * - Unix: `chmod 0600` (a folder `0700`), then read the mode back.
 * - Windows: `icacls <path> /inheritance:r /grant:r *<SID>:F` (a folder
 *   `(OI)(CI)F`, so what is created inside it is owner-only too), then the
 *   access list is read back; explicit entries for other principals that
 *   survive the inheritance removal are removed (`/remove *<SID>`) and the list
 *   is read again. Accepted only when every access entry is the current
 *   account's.
 *
 * Windows works on security identifiers (SIDs), never on account names:
 * icacls prints names and paths in the OEM code page (measured on a Windows
 * runner: `ü` came out as byte 0x81, `Č` as `C`), so a name or path that is
 * not ASCII cannot be matched in its text output — every write for such a
 * user would be refused. The current account's SID comes from
 * `whoami /user /fo csv /nh` (the SID column is ASCII); the access list is
 * read with `icacls <path> /save <file>`, which writes it as SDDL in UTF-16
 * (SIDs, or SDDL abbreviations such as `SY`, `BA`), whatever the system
 * language.
 *
 * Commands run through execFile with an argument array, never a shell, so a
 * path with spaces or shell characters is one argument; on Windows they run
 * from `%SystemRoot%\System32` by full path, so a planted `icacls.exe` or
 * `whoami.exe` in the working folder is never run.
 */

export type OwnerOnlyExec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

export type OwnerOnlyResult = { ok: true } | { ok: false; detail: string }

/** `checkOwnerOnly` can also not know: icacls failed, named no entry, or the account is unknown. */
export type OwnerOnlyCheck = OwnerOnlyResult | { ok: 'unknown'; detail: string }

export interface OwnerOnlyOptions {
  /** Default: the host's platform ({@link _ownerOnlyHost}). */
  platform?: NodeJS.Platform
  /** Runs icacls and whoami on Windows. Default: execFile. */
  exec?: OwnerOnlyExec
  /**
   * `DOMAIN\user` on Windows. Default: {@link currentWindowsAccount}. Only
   * used to tell "known" from "unknown": an explicit null (or no USERNAME)
   * means the account is not known and nothing is protected. The account is
   * identified by its SID ({@link currentWindowsSid}), never by this name.
   */
  account?: string | null
  /** The path is a folder: 0700 / an inheritable grant. */
  directory?: boolean
}

/** Full path of a Windows system tool, so a planted copy in the working folder is never run. Internal; exported for tests. */
export function _systemTool(cmd: string, env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR
  return root && (cmd === 'icacls' || cmd === 'whoami') ? join(root, 'System32', `${cmd}.exe`) : cmd
}

function defaultExec(cmd: string, args: string[]): { status: number | null; stdout: string } {
  try {
    const stdout = execFileSync(_systemTool(cmd, process.env), args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string }
    return { status: typeof err.status === 'number' ? err.status : null, stdout: typeof err.stdout === 'string' ? err.stdout : '' }
  }
}

/**
 * Platform, environment and command runner used when a caller passes none.
 * Internal (not exported from the package); tests swap the fields to drive
 * the Windows branch on any OS. `atomicWrite` reads the same object (it is
 * `sync.ts`'s `_atomicWriteAcl`), so a simulated host covers both halves of a
 * config write.
 */
export const _ownerOnlyHost: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exec: OwnerOnlyExec } = {
  platform: process.platform,
  env: process.env,
  exec: defaultExec,
}

/** `DOMAIN\user` for the current Windows account, or null when it is not known. */
export function currentWindowsAccount(env: NodeJS.ProcessEnv = _ownerOnlyHost.env): string | null {
  const user = env.USERNAME
  if (!user) return null
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user
}

const SID = /^S-1-\d+(-\d+)+$/i
const sidCache = new WeakMap<OwnerOnlyExec, string>()

/**
 * The current Windows account's SID (`whoami /user /fo csv /nh`), or null
 * when it cannot be read. Cached per command runner once known.
 */
export function currentWindowsSid(exec: OwnerOnlyExec = _ownerOnlyHost.exec): string | null {
  const hit = sidCache.get(exec)
  if (hit) return hit
  const r = exec('whoami', ['/user', '/fo', 'csv', '/nh'])
  if (r.status !== 0) return null
  // `"DOMAIN\name","S-1-5-21-…"` — the name may be in any code page; the SID,
  // the last column, is ASCII.
  const m = /"(S-1-\d+(?:-\d+)+)"\s*$/i.exec(r.stdout.trim())
  if (!m) return null
  sidCache.set(exec, m[1])
  return m[1]
}

/** SDDL abbreviations of well-known SIDs that can sit in a file's access list, and their SIDs. */
const WELL_KNOWN: Record<string, string> = {
  SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20',
  BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547',
  AO: 'S-1-5-32-548', SO: 'S-1-5-32-549', PO: 'S-1-5-32-550', BO: 'S-1-5-32-551',
  RE: 'S-1-5-32-552', RU: 'S-1-5-32-554', RD: 'S-1-5-32-555', NO: 'S-1-5-32-556',
  MU: 'S-1-5-32-558', LU: 'S-1-5-32-559', IS: 'S-1-5-32-568', CY: 'S-1-5-32-569',
  ER: 'S-1-5-32-573',
  WD: 'S-1-1-0', CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4',
  NU: 'S-1-5-2', IU: 'S-1-5-4', SU: 'S-1-5-6', AN: 'S-1-5-7', ED: 'S-1-5-9',
  PS: 'S-1-5-10', AU: 'S-1-5-11', RC: 'S-1-5-12', WR: 'S-1-5-33',
  AC: 'S-1-15-2-1',
}

/** Names for the principals a report most often names. */
const DISPLAY: Record<string, string> = {
  SY: 'NT AUTHORITY\\SYSTEM', BA: 'BUILTIN\\Administrators', BU: 'BUILTIN\\Users',
  AU: 'NT AUTHORITY\\Authenticated Users', WD: 'Everyone', CO: 'CREATOR OWNER',
  CG: 'CREATOR GROUP', OW: 'OWNER RIGHTS', IU: 'NT AUTHORITY\\INTERACTIVE',
}

/** Is this ACE trustee (a SID or an SDDL abbreviation) the current account? */
function isSelf(trustee: string, sid: string): boolean {
  const t = trustee.toUpperCase()
  if (t === sid.toUpperCase()) return true
  // SDDL writes the local machine's built-in Administrator (RID 500) and Guest
  // (RID 501) accounts as `LA` / `LG` — a GitHub runner's account is `LA`.
  if (t === 'LA') return /-500$/.test(sid)
  if (t === 'LG') return /-501$/.test(sid)
  return false
}

type AclRead =
  | { kind: 'ok' }
  | { kind: 'shared'; others: string[] }
  | { kind: 'unknown'; detail: string }

/**
 * UTF-16LE (what icacls writes) or UTF-8, BOM stripped. The SDDL line is
 * ASCII, so in UTF-16 at least a quarter of the bytes are zero whatever the
 * file's name; UTF-8 text has none.
 */
function decodeSaved(buf: Buffer): string {
  let zeros = 0
  for (const b of buf) if (b === 0) zeros++
  const utf16 = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) || (zeros > 0 && zeros * 4 >= buf.length)
  return (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '')
}

/**
 * Read `path`'s access list as SDDL (`icacls <path> /save <file>`) and classify
 * it against `sid`. A failed read, an unreadable file or a list with no entry
 * is `unknown`, never ok.
 */
function readAcl(path: string, exec: OwnerOnlyExec, sid: string): AclRead {
  const saved = join(tmpdir(), `plur-acl-${process.pid}-${randomBytes(6).toString('hex')}.txt`)
  let text: string
  try {
    const r = exec('icacls', [path, '/save', saved])
    if (r.status !== 0) return { kind: 'unknown', detail: `icacls could not read the access list (exit ${r.status ?? 'unknown'})` }
    try {
      text = decodeSaved(readFileSync(saved))
    } catch {
      return { kind: 'unknown', detail: 'icacls wrote no access list' }
    }
  } finally {
    try { unlinkSync(saved) } catch { /* not written */ }
  }
  // Line 1 is the file's name, line 2 its SDDL (`D:<flags>(ace)(ace)…`).
  const sddl = text.split(/\r?\n/).slice(1).join('\n')
  const m = /D:([A-Z]*)((?:\([^()]*\))*)/.exec(sddl)
  if (!m) return { kind: 'unknown', detail: 'icacls listed no access entries' }
  // A null access list grants everyone everything.
  if (/^NO_ACCESS_CONTROL/.test(sddl.slice(m.index + 2))) return { kind: 'shared', others: ['WD'] }
  // The entries must end where the list does (end of line, or the next
  // section). Anything else — a conditional entry with nested parentheses —
  // is not read past: it could hide an entry, so the answer is unknown.
  if (!/^(\s|$|[OGS]:)/.test(sddl.slice(m.index + m[0].length))) return { kind: 'unknown', detail: 'icacls listed an access entry PLUR cannot read' }
  const aces = [...m[2].matchAll(/\(([^)]*)\)/g)].map(a => a[1].split(';'))
  if (aces.length === 0) return { kind: 'unknown', detail: 'icacls listed no access entries' }
  const others = new Set<string>()
  for (const f of aces) {
    const trustee = f[5]
    if (!trustee) return { kind: 'unknown', detail: 'icacls listed an access entry it did not name' }
    if (!isSelf(trustee, sid)) others.add(trustee.toUpperCase())
  }
  return others.size === 0 ? { kind: 'ok' } : { kind: 'shared', others: [...others] }
}

const displayOf = (t: string) => DISPLAY[t] ?? t
const alsoReadableBy = (others: string[]) => `also readable by ${others.map(displayOf).join(', ')}`

function resolve(opts: OwnerOnlyOptions): { platform: NodeJS.Platform; exec: OwnerOnlyExec; account: string | null } {
  return {
    platform: opts.platform ?? _ownerOnlyHost.platform,
    exec: opts.exec ?? _ownerOnlyHost.exec,
    account: opts.account !== undefined ? opts.account : currentWindowsAccount(_ownerOnlyHost.env),
  }
}

const ACCOUNT_UNKNOWN = 'the Windows account is not known (USERNAME is not set)'
const SID_UNKNOWN = 'the Windows account is not known (whoami named no SID)'

/**
 * Make `path` readable by the current account only, and verify it. Any
 * result other than `{ ok: true }` means the protection is NOT established;
 * callers holding a secret must not treat it as done.
 */
export function protectOwnerOnly(path: string, opts: OwnerOnlyOptions = {}): OwnerOnlyResult {
  const { platform, exec, account } = resolve(opts)
  if (platform === 'win32') {
    if (!account) return { ok: false, detail: ACCOUNT_UNKNOWN }
    const sid = currentWindowsSid(exec)
    if (!sid) return { ok: false, detail: SID_UNKNOWN }
    const grant = `*${sid}:${opts.directory ? '(OI)(CI)' : ''}F`
    const set = exec('icacls', [path, '/inheritance:r', '/grant:r', grant])
    if (set.status !== 0) return { ok: false, detail: `icacls failed (exit ${set.status ?? 'unknown'})` }
    let r = readAcl(path, exec, sid)
    if (r.kind === 'shared') {
      // `/inheritance:r` drops only INHERITED entries. A file or folder can also
      // carry explicit entries for other principals — measured on a GitHub
      // Windows runner (#1631): NT AUTHORITY\SYSTEM and BUILTIN\Administrators
      // stayed on a new file after the grant. Remove every other principal by
      // its SID (grants and denies), then read the list back again.
      const targets: string[] = []
      for (const t of r.others) {
        const s = SID.test(t) ? t : WELL_KNOWN[t]
        if (!s) return { ok: false, detail: `${alsoReadableBy(r.others)} (cannot remove ${t})` }
        targets.push(`*${s}`)
      }
      const rm = exec('icacls', [path, '/remove', ...targets])
      if (rm.status !== 0) return { ok: false, detail: `icacls failed (exit ${rm.status ?? 'unknown'})` }
      r = readAcl(path, exec, sid)
    }
    if (r.kind === 'ok') return { ok: true }
    return { ok: false, detail: r.kind === 'shared' ? alsoReadableBy(r.others) : r.detail }
  }
  const want = opts.directory ? 0o700 : 0o600
  try {
    chmodSync(path, want)
  } catch (e) {
    return { ok: false, detail: `chmod failed (${e instanceof Error ? e.message : String(e)})` }
  }
  let mode: number
  try {
    mode = statSync(path).mode & 0o777
  } catch (e) {
    return { ok: false, detail: `could not read the mode back (${e instanceof Error ? e.message : String(e)})` }
  }
  if (mode !== want) return { ok: false, detail: `mode is ${mode.toString(8)}, expected ${want.toString(8)}` }
  return { ok: true }
}

/**
 * Is `path` owner-only? Only reads (`statSync` / the access list). Unix:
 * owner-only means no group or other bit. A read that fails is `unknown`,
 * never `ok` — `plur doctor` reports it as a failure.
 */
export function checkOwnerOnly(path: string, opts: OwnerOnlyOptions = {}): OwnerOnlyCheck {
  const { platform, exec, account } = resolve(opts)
  if (platform === 'win32') {
    if (!account) return { ok: 'unknown', detail: ACCOUNT_UNKNOWN }
    const sid = currentWindowsSid(exec)
    if (!sid) return { ok: 'unknown', detail: SID_UNKNOWN }
    const r = readAcl(path, exec, sid)
    return r.kind === 'ok' ? { ok: true } : r.kind === 'shared' ? { ok: false, detail: alsoReadableBy(r.others) } : { ok: 'unknown', detail: r.detail }
  }
  let mode: number
  try {
    mode = statSync(path).mode & 0o777
  } catch (e) {
    return { ok: 'unknown', detail: `could not read the mode (${e instanceof Error ? e.message : String(e)})` }
  }
  if ((mode & 0o077) !== 0) return { ok: false, detail: `mode is ${mode.toString(8)}, expected ${(opts.directory ? 0o700 : 0o600).toString(8)}` }
  return { ok: true }
}
