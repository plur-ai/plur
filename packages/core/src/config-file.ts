import { existsSync, chmodSync } from 'fs'
import { basename } from 'path'
import { atomicWrite, ALLOW_UNPROTECTED_ENV, CONFIG_FILE_MODE, _atomicWriteAcl } from './atomic-write.js'
import { checkOwnerOnly, protectOwnerOnly, type OwnerOnlyResult } from './owner-only.js'

/**
 * The one way core writes `config.yaml` (device key, tokens); every write is made owner-only:
 * 1. Unix: an existing file is tightened to 0600 first (atomicWrite keeps its mode).
 * 2. `atomicWrite(…, { mode: 0600, secret: true })` — on Windows refuses (throws)
 *    unless the temp file is owner-only before its first byte.
 * 3. {@link protectOwnerOnly} re-applies and verifies. If that fails (or the
 *    unprotected opt-out is set) the write still stands: one stderr line is logged,
 *    the failure is returned, and `plur doctor` re-checks.
 * `content` may be bytes (backup restores). test/config-owner-only.test.ts keeps every
 * config writer here; kept apart from sync.ts (crash-test seam) and owner-only.ts (cycles).
 */
export function writeConfigFile(path: string, content: string | Buffer): OwnerOnlyResult {
  if (_atomicWriteAcl.platform !== 'win32' && existsSync(path)) {
    try { chmodSync(path, CONFIG_FILE_MODE) } catch { /* reported by the check below */ }
  }
  // With PLUR_ALLOW_UNPROTECTED_CONFIG set, atomicWrite hands back why it
  // wrote without protection instead of printing it, so one line is printed.
  let unprotected: string | null = null
  atomicWrite(path, content, { mode: CONFIG_FILE_MODE, secret: true, onUnprotected: cause => { unprotected = cause } })
  // On Windows the renamed file carries the temp file's verified list, so one
  // read usually settles it; anything but a clean owner-only reading is
  // re-protected (and verified) rather than trusted.
  const seen = _atomicWriteAcl.platform === 'win32' ? checkOwnerOnly(path) : null
  const r: OwnerOnlyResult = seen?.ok === true ? { ok: true } : protectOwnerOnly(path)
  // At most one line: the opt-out warning whenever the content went out
  // unprotected (even if the file was protected afterwards), else the failure.
  if (unprotected !== null) {
    console.error(`[plur:config] wrote ${basename(path)} WITHOUT owner-only protection (${ALLOW_UNPROTECTED_ENV} is set): ${unprotected}`)
  } else if (!r.ok) {
    console.error(`[plur:config] could not restrict ${basename(path)} to your account: ${r.detail}`)
  }
  return r
}
