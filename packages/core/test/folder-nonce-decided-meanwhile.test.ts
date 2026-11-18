/**
 * A folder question's nonce answers the question as it was shown: while the
 * folder is undecided (ask). When the folder is decided another way before the
 * answer is redeemed (by hand, or by a parent entry), a nonce-redeemed write or
 * removal is refused with 'nonce-stale', changes nothing and consumes nothing,
 * so the question is shown again. "Not now" writes nothing, so it still works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  answerFolderNotNow, folderMapPath, folderNonceOutstanding, issueFolderNonce, removeFolderEntry,
  resolveFolderPolicy, setFolderEntry, FolderMapError,
} from '../src/index.js'

const TEAM = 'group:team/x'
const opts = { configuredScopes: [TEAM], remoteScopes: [TEAM] }

let root: string
let parent: string
let dir: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nonce-stale-home-')))
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'nonce-stale-parent-')))
  dir = join(parent, 'proj')
  mkdirSync(dir)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(parent, { recursive: true, force: true })
})

function code(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof FolderMapError ? e.code : String(e) }
}
const mapText = () => existsSync(folderMapPath(root)) ? readFileSync(folderMapPath(root), 'utf8') : ''

describe('a nonce redeemed after the folder was decided another way', () => {
  it('--scope X --on is refused once a parent became remote-only, and the folder stays remote-only', () => {
    expect(resolveFolderPolicy(dir, { root, readOnly: true }).mode).toBe('ask')
    const n = issueFolderNonce(root, 'ses', dir, { scope: TEAM })
    setFolderEntry(root, parent, { mode: 'remote-only', scope: TEAM }, opts)
    const before = mapText()
    let err: unknown
    try { setFolderEntry(root, dir, { scope: TEAM, mode: 'on' }, { ...opts, nonce: n }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(FolderMapError)
    expect((err as FolderMapError).code).toBe('nonce-stale')
    expect((err as FolderMapError).message).toMatch(/decided/)
    expect((err as FolderMapError).message).toMatch(/nothing was changed/)
    expect(mapText()).toBe(before)
    expect(resolveFolderPolicy(dir, { root, readOnly: true }).mode).toBe('remote-only')
    expect(folderNonceOutstanding(root, 'ses', n)).toBe(true)
  })

  it('--scope X alone is refused the same way', () => {
    const n = issueFolderNonce(root, 'ses', dir, { scope: TEAM })
    setFolderEntry(root, parent, { mode: 'remote-only', scope: TEAM }, opts)
    expect(code(() => setFolderEntry(root, dir, { scope: TEAM }, { ...opts, nonce: n }))).toBe('nonce-stale')
  })

  it('--on is refused after the folder was set --off by hand', () => {
    const n = issueFolderNonce(root, 'ses', dir, { mode: 'on' })
    setFolderEntry(root, dir, { mode: 'off' }, opts)
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { ...opts, nonce: n }))).toBe('nonce-stale')
    expect(resolveFolderPolicy(dir, { root, readOnly: true }).mode).toBe('off')
  })

  it('removal with a nonce is refused after the entry was decided by hand', () => {
    setFolderEntry(root, dir, { mode: 'ask' }, opts)
    const n = issueFolderNonce(root, 'ses', dir, { remove: true })
    setFolderEntry(root, dir, { mode: 'on' }, opts)
    const before = mapText()
    expect(code(() => removeFolderEntry(root, dir, undefined, { nonce: n }))).toBe('nonce-stale')
    expect(mapText()).toBe(before)
    expect(folderNonceOutstanding(root, 'ses', n)).toBe(true)
  })

  it('the kept nonce works again once the folder is undecided again', () => {
    const n = issueFolderNonce(root, 'ses', dir, { mode: 'on' })
    setFolderEntry(root, parent, { mode: 'remote-only', scope: TEAM }, opts)
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { ...opts, nonce: n }))).toBe('nonce-stale')
    removeFolderEntry(root, parent)
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { ...opts, nonce: n }))).toBeNull()
    expect(folderNonceOutstanding(root, 'ses', n)).toBe(false)
  })

  it('a wrong-answer nonce keeps its own refusal on a decided folder', () => {
    const n = issueFolderNonce(root, 'ses', dir, { mode: 'off' })
    setFolderEntry(root, dir, { mode: 'on' }, opts)
    expect(code(() => setFolderEntry(root, dir, { mode: 'on' }, { ...opts, nonce: n }))).toBe('nonce-answer')
  })

  it('"not now" writes nothing, so it is still accepted on a decided folder', () => {
    const n = issueFolderNonce(root, 'ses', dir, { notNow: true }, Date.now(), { bindSession: true })
    setFolderEntry(root, dir, { mode: 'off' }, opts)
    expect(code(() => answerFolderNotNow(root, dir, n, { session: 'ses' }))).toBeNull()
    expect(folderNonceOutstanding(root, 'ses', n)).toBe(false)
  })
})
