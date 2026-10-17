import { execFileSync } from 'child_process'

/**
 * Owner-only protection for files and folders that hold a secret, on Windows
 * (icacls) — the rule core's config protection uses: remove inherited access,
 * grant only the current account, then read the ACL back and accept it only
 * when every entry names exactly that account.
 *
 * icacls runs through execFile with an argument array, never a shell, so a
 * path with spaces or shell characters is one argument.
 */

export type OwnerOnlyExec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

export type OwnerOnlyResult = { ok: true } | { ok: false; detail: string }

/** `DOMAIN\user` for the current Windows account, or null when it is not known. */
export function currentWindowsAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const user = env.USERNAME
  if (!user) return null
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user
}

export const defaultExec: OwnerOnlyExec = (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string }
    return { status: typeof err.status === 'number' ? err.status : null, stdout: typeof err.stdout === 'string' ? err.stdout : '' }
  }
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

/**
 * Make `path` readable by the current account only, and verify it. A folder
 * gets an inheritable grant (`(OI)(CI)`), so what is created inside it is
 * owner-only too. Windows only; the caller handles other platforms.
 */
export function protectOwnerOnlyWindows(
  path: string,
  opts: { directory: boolean; account: string | null; exec?: OwnerOnlyExec },
): OwnerOnlyResult {
  const exec = opts.exec ?? defaultExec
  if (!opts.account) return { ok: false, detail: 'the Windows account is not known (USERNAME is not set)' }
  const grant = `${opts.account}:${opts.directory ? '(OI)(CI)' : ''}F`
  const set = exec('icacls', [path, '/inheritance:r', '/grant:r', grant])
  if (set.status !== 0) return { ok: false, detail: `icacls failed (exit ${set.status ?? 'unknown'})` }
  const read = exec('icacls', [path])
  if (read.status !== 0) return { ok: false, detail: `icacls could not read the access list (exit ${read.status ?? 'unknown'})` }
  const principals = icaclsPrincipals(path, read.stdout)
  if (principals.length === 0) return { ok: false, detail: 'icacls listed no access entries' }
  const others = [...new Set(principals.filter(p => p.toLowerCase() !== opts.account!.toLowerCase()))]
  if (others.length > 0) return { ok: false, detail: `also readable by ${others.join(', ')}` }
  return { ok: true }
}
