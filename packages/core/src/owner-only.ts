import { execFileSync } from 'child_process'
import { chmodSync, statSync } from 'fs'

/**
 * Owner-only protection for files (and folders) that hold a secret (#1631,
 * plan B Task 1b; audit finding 2). One rule for every caller — core's
 * config.yaml writes, atomicWrite's temporary files, the enterprise
 * installer's backups and key file:
 *
 * - Unix: `chmod 0600` (a folder `0700`), then read the mode back.
 * - Windows: `icacls <path> /inheritance:r /grant:r <account>:F` (a folder
 *   `(OI)(CI)F`, so what is created inside it is owner-only too), then
 *   `icacls <path>`, accepted only when every access entry names exactly the
 *   current account.
 *
 * icacls runs through execFile with an argument array, never a shell, so a
 * path with spaces or shell characters is one argument.
 */

export type OwnerOnlyExec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

export type OwnerOnlyResult = { ok: true } | { ok: false; detail: string }

/** `checkOwnerOnly` can also not know: icacls failed, named no account, or the account is unknown. */
export type OwnerOnlyCheck = OwnerOnlyResult | { ok: 'unknown'; detail: string }

export interface OwnerOnlyOptions {
  /** Default: the host's platform ({@link _ownerOnlyHost}). */
  platform?: NodeJS.Platform
  /** Runs icacls on Windows. Default: execFile. */
  exec?: OwnerOnlyExec
  /** `DOMAIN\user` on Windows. Default: {@link currentWindowsAccount}; an explicit null means unknown. */
  account?: string | null
  /** The path is a folder: 0700 / an inheritable grant. */
  directory?: boolean
}

function defaultExec(cmd: string, args: string[]): { status: number | null; stdout: string } {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
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

/**
 * The principals named in `icacls <path>` output. The first line starts with
 * the path itself; the summary line ("Successfully processed …") and blank
 * lines are not entries.
 */
export function icaclsPrincipals(path: string, stdout: string): string[] {
  const principals: string[] = []
  let first = true
  for (const raw of stdout.split(/\r?\n/)) {
    let line = raw
    if (first && line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length)
    first = false
    const t = line.trim()
    if (!t) continue
    if (/^Successfully processed/i.test(t) || /^Failed processing/i.test(t)) continue
    const m = /^(.+?):\(/.exec(t)
    if (m) principals.push(m[1])
  }
  return principals
}

function resolve(opts: OwnerOnlyOptions): { platform: NodeJS.Platform; exec: OwnerOnlyExec; account: string | null } {
  return {
    platform: opts.platform ?? _ownerOnlyHost.platform,
    exec: opts.exec ?? _ownerOnlyHost.exec,
    account: opts.account !== undefined ? opts.account : currentWindowsAccount(_ownerOnlyHost.env),
  }
}

/** Read the Windows access list: only the account → ok; another → ok:false; cannot tell → unknown. */
function readAcl(path: string, exec: OwnerOnlyExec, account: string): OwnerOnlyCheck {
  const read = exec('icacls', [path])
  if (read.status !== 0) return { ok: 'unknown', detail: `icacls could not read the access list (exit ${read.status ?? 'unknown'})` }
  const principals = icaclsPrincipals(path, read.stdout)
  if (principals.length === 0) return { ok: 'unknown', detail: 'icacls listed no access entries' }
  const others = [...new Set(principals.filter(p => p.toLowerCase() !== account.toLowerCase()))]
  if (others.length > 0) return { ok: false, detail: `also readable by ${others.join(', ')}` }
  return { ok: true }
}

const ACCOUNT_UNKNOWN = 'the Windows account is not known (USERNAME is not set)'

/**
 * Make `path` readable by the current account only, and verify it. Any
 * result other than `{ ok: true }` means the protection is NOT established;
 * callers holding a secret must not treat it as done.
 */
export function protectOwnerOnly(path: string, opts: OwnerOnlyOptions = {}): OwnerOnlyResult {
  const { platform, exec, account } = resolve(opts)
  if (platform === 'win32') {
    if (!account) return { ok: false, detail: ACCOUNT_UNKNOWN }
    const grant = `${account}:${opts.directory ? '(OI)(CI)' : ''}F`
    const set = exec('icacls', [path, '/inheritance:r', '/grant:r', grant])
    if (set.status !== 0) return { ok: false, detail: `icacls failed (exit ${set.status ?? 'unknown'})` }
    const r = readAcl(path, exec, account)
    return r.ok === true ? r : { ok: false, detail: r.detail }
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
 * Is `path` owner-only? Only reads (`statSync` / `icacls <path>`). Unix:
 * owner-only means no group or other bit. A read that fails is `unknown`,
 * never `ok` — `plur doctor` reports it as a failure.
 */
export function checkOwnerOnly(path: string, opts: OwnerOnlyOptions = {}): OwnerOnlyCheck {
  const { platform, exec, account } = resolve(opts)
  if (platform === 'win32') {
    if (!account) return { ok: 'unknown', detail: ACCOUNT_UNKNOWN }
    return readAcl(path, exec, account)
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
