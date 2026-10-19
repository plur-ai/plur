/**
 * The installer's key file protection (#1638, plan C Task 4; audit finding 2).
 *
 * A thin wrapper over core's `protectOwnerOnly`, so the installer and every
 * later core write of config.yaml apply the same rule: Unix `chmod 0600`,
 * read back; Windows `icacls /inheritance:r /grant:r *<SID>:F`, other
 * principals removed, the access list read back as SDDL and accepted only
 * when every entry is the current account's (by SID, never by name). No
 * second implementation in the CLI.
 *
 * `exec`: leave it undefined for a real run — core then runs icacls and
 * whoami from `%SystemRoot%\System32` by full path, so a planted `icacls.exe`
 * in the working folder is never run. Tests pass a fake.
 */
import { protectOwnerOnly, type OwnerOnlyExec, type OwnerOnlyResult } from '@plur-ai/core'

export function protectKeyFile(
  path: string,
  platform: NodeJS.Platform,
  exec: OwnerOnlyExec | undefined,
  user: string | null,
): OwnerOnlyResult {
  return protectOwnerOnly(path, { platform, ...(exec ? { exec } : {}), account: user })
}
