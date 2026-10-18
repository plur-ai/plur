/**
 * A fake Windows `icacls` / `whoami` for owner-only tests on any OS (#1631).
 * Core reads an access list with `icacls <path> /save <file>` (UTF-16LE: the
 * file's name, then SDDL) and the current account's SID with
 * `whoami /user /fo csv /nh`; this fake answers both the way the real tools do.
 */
import { writeFileSync } from 'node:fs'

/** The current account's SID in these tests (`ACME\alice`). */
export const SELF = 'S-1-5-21-1111-2222-3333-1001'

export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

/** What `icacls <path> /save <file>` writes, for these ACE trustees (SIDs or SDDL abbreviations). */
export function writeSaved(file: string, trustees: string[], daclFlags = 'PAI'): void {
  const aces = trustees.map(t => `(A;;FA;;;${t})`).join('')
  writeFileSync(file, Buffer.from(`name.yaml\r\nD:${daclFlags}${aces}\r\n`, 'utf16le'))
}

export interface FakeAcl {
  /** Trustees on `path` (SIDs or abbreviations); null → icacls fails reading it (exit 5). */
  acl: (path: string) => string[] | null
  /** `/inheritance:r /grant:r <grant>`: exit status (default 0). */
  grant?: (path: string, grant: string) => number
  /** `/remove <*sid…>`: exit status (default 0). */
  remove?: (path: string, sids: string[]) => number
  /** whoami's answer (default: SELF). */
  whoami?: () => { status: number | null; stdout: string }
}

/** A command runner that records every call and answers like icacls / whoami. */
export function fakeAclExec(f: FakeAcl): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'whoami') return f.whoami ? f.whoami() : { status: 0, stdout: `"ACME\\alice","${SELF}"\r\n` }
    if (cmd !== 'icacls') return { status: 9009, stdout: '' }
    const [p, op, ...rest] = args
    if (op === '/save') {
      const t = f.acl(p)
      if (t === null) return { status: 5, stdout: '' }
      writeSaved(rest[0], t)
      return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files' }
    }
    if (op === '/inheritance:r' && rest[0] === '/grant:r') return { status: f.grant ? f.grant(p, rest[1]) : 0, stdout: '' }
    if (op === '/remove') return { status: f.remove ? f.remove(p, rest) : 0, stdout: '' }
    return { status: 87, stdout: '' }
  }
  return { exec, calls }
}

/** Only the calls that change or read an access list (whoami left out). */
export const icaclsCalls = (calls: string[][]) => calls.filter(c => c[0] === 'icacls').map(c => c[2] === '/save' ? c.slice(0, 3) : c)
