/**
 * The once-per-session folder question is once per session AND folder
 * (finding G2 of the 0.21.1 Codex/Cursor pre-release check).
 *
 * The marker that records "this session was asked" was keyed by the session
 * id alone, so the first PLUR hook to ask in a session silenced every other
 * hook in it, even one asking about a different folder (a second hook set, or
 * a hook that ran with another working folder). It is now keyed by session
 * and folder. A resume still clears every marker of that session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { resolveFolderPolicy, folderAskOnce, clearFolderAsk } from '../src/index.js'

let root: string
let a: string
let b: string
let session: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ask-marker-store-')))
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ask-marker-ws-')))
  a = join(base, 'a')
  b = join(base, 'b')
  mkdirSync(a)
  mkdirSync(b)
  session = `ask-marker-${randomUUID()}`
})
afterEach(() => {
  clearFolderAsk(session)
  rmSync(root, { recursive: true, force: true })
})

const ask = (dir: string): string | null =>
  folderAskOnce({ dir, policy: resolveFolderPolicy(dir, { root }), sessionId: session, root })

describe('the folder question marker is per session and folder (G2)', () => {
  it('two folders in one session are each asked once', () => {
    expect(resolveFolderPolicy(a, { root }).mode).toBe('ask')
    expect(ask(a)).toContain('no decision for this folder yet')
    expect(ask(b), 'a second folder in the same session was silenced').toContain('no decision for this folder yet')
    expect(ask(a)).toBeNull()
    expect(ask(b)).toBeNull()
  })

  it('a resume clears the session for every folder it asked about', () => {
    expect(ask(a)).not.toBeNull()
    expect(ask(b)).not.toBeNull()
    clearFolderAsk(session)
    expect(ask(a)).not.toBeNull()
    expect(ask(b)).not.toBeNull()
  })

  it('a session asked under 0.21.0 (marker <session>.folder-asked) is not asked again after the upgrade (audit L6 of #1583)', () => {
    const dir = join(tmpdir(), 'plur-sessions')
    mkdirSync(dir, { recursive: true })
    const legacy = join(dir, `${session}.folder-asked`)
    writeFileSync(legacy, String(Date.now()))
    expect(ask(a), 'the upgraded hook asked an already-asked session again').toBeNull()
    expect(ask(b)).toBeNull()
    // A resume still clears it, and the session is asked again.
    clearFolderAsk(session)
    expect(existsSync(legacy)).toBe(false)
    expect(ask(a)).toContain('no decision for this folder yet')
  })
})
