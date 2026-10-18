/**
 * Folder nonces bound to the session they were issued in (audit F5 of
 * #1517). A host that can tell `plur folders set` which session runs it
 * (opencode, through its shell.env hook, as PLUR_FOLDER_SESSION) gets nonces
 * that work only in that session. The editor hooks' nonces stay unbound —
 * their hosts cannot tell the command its session — but a command that does
 * name a session only finds that session's nonces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { issueFolderNonce, setFolderEntry, FolderMapError } from '../src/index.js'

let root: string
let dir: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nonce-session-home-')))
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nonce-session-dir-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

function code(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof FolderMapError ? e.code : String(e) }
}
const set = (nonce: string, session?: string) =>
  setFolderEntry(root, dir, { mode: 'on' }, { configuredScopes: [], nonce, ...(session ? { session } : {}) })

describe('session-bound folder nonces', () => {
  it('a bound nonce works in its own session', () => {
    const n = issueFolderNonce(root, 'ses_A', dir, { mode: 'on' }, Date.now(), { bindSession: true })
    expect(code(() => set(n, 'ses_A'))).toBeNull()
  })

  it('a bound nonce is refused in another session', () => {
    const n = issueFolderNonce(root, 'ses_A', dir, { mode: 'on' }, Date.now(), { bindSession: true })
    expect(code(() => set(n, 'ses_B'))).toBe('nonce-session')
    // and is still usable in its own session afterwards
    expect(code(() => set(n, 'ses_A'))).toBeNull()
  })

  it('a bound nonce is refused when the command names no session', () => {
    const n = issueFolderNonce(root, 'ses_A', dir, { mode: 'on' }, Date.now(), { bindSession: true })
    expect(code(() => set(n))).toBe('nonce-session')
  })

  it('an unbound nonce (the editor hooks) still works with no session named', () => {
    const n = issueFolderNonce(root, 'hook-session', dir, { mode: 'on' })
    expect(code(() => set(n))).toBeNull()
  })

  it('an unbound nonce is refused when the command names a different session', () => {
    const n = issueFolderNonce(root, 'hook-session', dir, { mode: 'on' })
    expect(code(() => set(n, 'other'))).toBe('nonce-session')
  })
})
