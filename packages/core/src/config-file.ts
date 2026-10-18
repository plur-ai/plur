import { existsSync, chmodSync } from 'fs'
import { basename } from 'path'
import { atomicWrite, ALLOW_UNPROTECTED_ENV, CONFIG_FILE_MODE, _atomicWriteAcl } from './sync.js'
import { checkOwnerOnly, protectOwnerOnly, type OwnerOnlyResult } from './owner-only.js'

/**
 * The one way core writes `config.yaml` (#1631, plan B Task 1b; audit
 * finding 2). The file holds the device key and remote bearer tokens, so it
 * stays owner-only after EVERY write:
 *
 * 1. Unix: an existing file is tightened to 0600 first, so the new content is
 *    never published at a wider mode (atomicWrite keeps the destination's own
 *    mode).
 * 2. `atomicWrite(…, { mode: 0600, secret: true })` — on Windows the temp file
 *    is owner-only before its first byte, and the write is refused (throws,
 *    nothing written) when that cannot be established (owner decisions 38/42).
 * 3. {@link protectOwnerOnly} re-applies and verifies the protection on the
 *    file now in place (on Windows a clean {@link checkOwnerOnly} reading of
 *    the renamed file is enough — it carries the temp file's verified list). A failure here is not swallowed: one stderr line, and
 *    the result is returned. The write itself stands — losing the key would
 *    be worse — and `plur doctor` re-checks it.
 *
 * A static test keeps every config writer on this path
 * (test/config-owner-only.test.ts). It lives apart from sync.ts so that it
 * calls `atomicWrite` through the module's export — the seam tests use to
 * simulate a crash mid-write — and apart from owner-only.ts so no import
 * cycle forms.
 */
export function writeConfigFile(path: string, content: string): OwnerOnlyResult {
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
  // One line: the opt-out's (whenever the content went out unprotected, even
  // if the file in place could be protected afterwards), else the plan's.
  if (unprotected !== null) {
    console.error(`[plur:config] wrote ${basename(path)} WITHOUT owner-only protection (${ALLOW_UNPROTECTED_ENV} is set): ${unprotected}`)
  } else if (!r.ok) {
    console.error(`[plur:config] could not restrict ${basename(path)} to your account: ${r.detail}`)
  }
  return r
}
