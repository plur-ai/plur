/**
 * Orphaned folder-nonce files are swept (audit F1 of #1529). A session whose
 * end is never reported (an MCP server killed with SIGKILL, a missed
 * SessionEnd hook) leaves its nonce file behind. Every redemption reads every
 * file in the directory, so they must not pile up: a file whose newest nonce
 * is older than the nonce lifetime is deleted, on the next issue or by an
 * explicit sweep. A file that still holds a live nonce is kept.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, readdirSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { issueFolderNonce, sweepFolderNonces, folderNonceOutstanding, setFolderEntry, FolderMapError, FOLDER_NONCE_TTL_MS } from '../src/index.js'

let root: string
let dir: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nonce-sweep-home-')))
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nonce-sweep-dir-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

const files = () => (existsSync(join(root, 'folder-nonces')) ? readdirSync(join(root, 'folder-nonces')) : [])

describe('sweeping orphaned folder-nonce files', () => {
  it('deletes a session file whose newest nonce is past the lifetime, keeps a live one', () => {
    const t0 = Date.now() - FOLDER_NONCE_TTL_MS - 60_000
    const live = issueFolderNonce(root, 'live-session', dir, { mode: 'on' })
    const old = issueFolderNonce(root, 'dead-session', dir, { mode: 'on' }, t0)
    expect(files()).toHaveLength(2)
    sweepFolderNonces(root)
    expect(folderNonceOutstanding(root, 'dead-session', old)).toBe(false)
    expect(folderNonceOutstanding(root, 'live-session', live)).toBe(true)
    expect(files()).toHaveLength(1)
  })

  it('issuing a nonce sweeps expired files of other sessions', () => {
    issueFolderNonce(root, 'dead-session', dir, { mode: 'on' }, Date.now() - FOLDER_NONCE_TTL_MS - 60_000)
    issueFolderNonce(root, 'new-session', dir, { mode: 'on' })
    expect(files()).toEqual(['new-session.yaml'])
  })

  it('a file with one live nonce among expired ones is kept', () => {
    issueFolderNonce(root, 's', dir, { mode: 'on' }, Date.now() - FOLDER_NONCE_TTL_MS - 60_000)
    const n = issueFolderNonce(root, 's', dir, { mode: 'off' })
    sweepFolderNonces(root)
    expect(folderNonceOutstanding(root, 's', n)).toBe(true)
  })

  it('an unreadable file is swept by its age on disk, a fresh one is left', () => {
    mkdirSync(join(root, 'folder-nonces'), { recursive: true })
    const stale = join(root, 'folder-nonces', 'garbage-old.yaml')
    const fresh = join(root, 'folder-nonces', 'garbage-new.yaml')
    writeFileSync(stale, ': : not yaml [')
    writeFileSync(fresh, ': : not yaml [')
    const past = (Date.now() - FOLDER_NONCE_TTL_MS - 60_000) / 1000
    utimesSync(stale, past, past)
    sweepFolderNonces(root)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('no nonce directory is not an error', () => {
    expect(() => sweepFolderNonces(root)).not.toThrow()
  })
})

describe('malformed nonce files never break folder answers (N12 of the #1529 review)', () => {
  const code = (fn: () => unknown): string | null => {
    try { fn(); return null } catch (e) { return e instanceof FolderMapError ? e.code : `${(e as Error)?.name}: ${(e as Error)?.message}` }
  }
  const garbage = (name: string, body: string) => {
    mkdirSync(join(root, 'folder-nonces'), { recursive: true })
    writeFileSync(join(root, 'folder-nonces', name), body)
    return join(root, 'folder-nonces', name)
  }

  it('a file with a null or garbage record does not make another session\'s answer fail', () => {
    garbage('broken.yaml', 'session: broken\nnonces:\n  - null\n  - 42\n  - nonce: 7\n')
    const n = issueFolderNonce(root, 'ses_ok', dir, { mode: 'on' }, Date.now(), { bindSession: true })
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { configuredScopes: [], nonce: n, session: 'ses_ok' }))).toBeNull()
  })

  it('an unknown nonce with a garbage file present is refused as unknown, not a TypeError', () => {
    garbage('broken.yaml', 'session: broken\nnonces: [null]\n')
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { configuredScopes: [], nonce: 'deadbeef' }))).toBe('nonce-unknown')
  })

  it('the sweep removes a file with only invalid records once it is old, and leaves a fresh one alone', () => {
    const stale = garbage('stale.yaml', 'session: stale\nnonces: [null]\n')
    const fresh = garbage('fresh.yaml', 'session: fresh\nnonces: [null]\n')
    const past = (Date.now() - FOLDER_NONCE_TTL_MS - 60_000) / 1000
    utimesSync(stale, past, past)
    sweepFolderNonces(root)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('a session file whose `session:` field is wrong does not make its new nonces unusable', () => {
    garbage('mcp-a.yaml', 'session: someone-else\nnonces: []\n')
    const n = issueFolderNonce(root, 'mcp-a', dir, { mode: 'on' }, Date.now(), { bindSession: true })
    expect(folderNonceOutstanding(root, 'mcp-a', n)).toBe(true)
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { configuredScopes: [], nonce: n, session: 'mcp-a' }))).toBeNull()
  })
})
