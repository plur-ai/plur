import { existsSync, mkdirSync, unlinkSync, chmodSync, lstatSync, openSync, closeSync, writeSync, fstatSync, fsyncSync } from 'fs'
import { join, basename } from 'path'
import { protectOwnerOnly, type OwnerOnlyExec } from '@plur-ai/core'

// Owner-only backups, shared by `plur login` (sign-in-shared.ts), the legacy
// .plur.yaml cleanup and plur-enterprise's own config cleanup.

/**
 * Writes `data` — the snapshot of `source` the cleanup is about to replace —
 * as a backup and returns its path; throws when it cannot be made safely.
 */
export type Backup = (source: string, data: Buffer) => string

/**
 * A backup writer for `backupDir`. Before the first backup, the folder is
 * created (or an existing one checked) and made owner-only, and that is
 * verified: 0700 on Unix (a symlink, a non-folder or a folder owned by
 * another account is refused), an owner-only ACL on Windows. Each backup is
 * created owner-only from the outset — opened with mode 0600 on Unix, and on
 * Windows created empty and given an owner-only ACL before the content is
 * written — so a secret is never readable by anyone else, not even briefly.
 * An existing backup is never overwritten: a second backup of the same file
 * gets a numbered name. When protection cannot be established the writer
 * throws, and the target is refused with nothing changed. The Windows rule is
 * core's `protectOwnerOnly` (#1631) — one implementation for config.yaml,
 * these backups and the installer's key file. `plur login` backs up
 * config.yaml and config.json through it too (sign-in-shared.ts).
 */
export function backupWriter(
  backupDir: string,
  o: { platform: NodeJS.Platform; exec?: OwnerOnlyExec; account: string | null },
): Backup {
  let dirReady: true | Error | null = null
  const win = o.platform === 'win32'
  const ensureDir = (): void => {
    if (dirReady === null) {
      try {
        protectBackupDir(backupDir, o)
        dirReady = true
      } catch (e) {
        dirReady = e instanceof Error ? e : new Error(String(e))
      }
    }
    if (dirReady !== true) throw dirReady
  }
  return (source: string, data: Buffer): string => {
    ensureDir()
    const name = basename(source)
    let dest = join(backupDir, name)
    for (let n = 1; existsSync(dest); n++) dest = join(backupDir, `${name}.${n}`)
    // 'wx': created new (O_EXCL), never an existing file or a planted link.
    const fd = openSync(dest, 'wx', 0o600)
    let written = false
    try {
      if (win) {
        const r = protectOwnerOnly(dest, { platform: 'win32', directory: false, account: o.account, exec: o.exec })
        if (!r.ok) throw new Error(`the backup ${dest} could not be made private: ${r.detail}`)
      } else if ((fstatSync(fd).mode & 0o077) !== 0) {
        throw new Error(`the backup ${dest} could not be made private`)
      }
      // writeSync may write fewer bytes than asked; a backup counts only when
      // all of it is written and on disk, since the config change after it
      // is itself fsynced (atomicWrite).
      for (let off = 0; off < data.length; ) {
        const n = writeSync(fd, data, off, data.length - off)
        if (n <= 0) throw new Error(`the backup ${dest} could not be written`)
        off += n
      }
      fsyncSync(fd)
      written = true
    } finally {
      closeSync(fd)
      if (!written) {
        try { unlinkSync(dest) } catch { /* nothing was written to it */ }
      }
    }
    return dest
  }
}

function protectBackupDir(dir: string, o: { platform: NodeJS.Platform; exec?: OwnerOnlyExec; account: string | null }): void {
  const fail = (why: string): never => {
    throw new Error(`the backup folder ${dir} could not be made private: ${why}; nothing was changed`)
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) fail('it is a symbolic link')
  if (!st.isDirectory()) fail('it is not a folder')
  if (o.platform === 'win32') {
    const r = protectOwnerOnly(dir, { platform: 'win32', directory: true, account: o.account, exec: o.exec })
    if (!r.ok) fail(r.detail)
    return
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) fail('it belongs to another account')
  if ((st.mode & 0o777) !== 0o700) {
    try {
      chmodSync(dir, 0o700)
    } catch (e) {
      fail(`chmod failed (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const mode = lstatSync(dir).mode & 0o777
  if (mode !== 0o700) fail(`mode is ${mode.toString(8)}, expected 700`)
}
