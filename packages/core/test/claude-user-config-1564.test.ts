/**
 * #1564 review: registering PLUR in Claude Code's ~/.claude.json, shared by
 * `plur init` and `plur-mcp init` (registerClaudeUserMcp).
 *
 *   L1 — a write that finds the file changed since it was read re-applies the
 *        edit to the fresh content (bounded retries) instead of overwriting it;
 *   L4 — a dangling symlink is named as such; a file with a byte-order mark is
 *        accepted (Claude Code accepts it and saves it without one);
 *   L5 — an `mcpServers` that is not an object is refused, with no backup;
 *   backups — at most the last 3 PLUR backups are kept, mode 0600.
 *
 * Everything runs in a temp directory; no real ~/.claude.json is touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { registerClaudeUserMcp } from '../src/claude-user-config.js'

const ENTRY = { command: '/opt/plur-mcp', args: [] as string[] }
let dir: string
let userPath: string
const read = () => JSON.parse(readFileSync(userPath, 'utf8'))
const backups = () => readdirSync(dir).filter(n => n.startsWith('.claude.json.plur-backup-')).sort()
const register = (extra: Partial<Parameters<typeof registerClaudeUserMcp>[0]> = {}) =>
  registerClaudeUserMcp({ userPath, entry: () => ({ ...ENTRY }), ...extra })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-claude-user-'))
  userPath = join(dir, '.claude.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('registerClaudeUserMcp (#1564 review)', () => {
  it('L1: a change made after PLUR read the file is kept, and the edit is re-applied on top of it', () => {
    writeFileSync(userPath, JSON.stringify({ a: 1 }), { mode: 0o600 })
    let fired = 0
    const r = register({
      _beforeWrite: () => {
        if (fired++ === 0) writeFileSync(userPath, JSON.stringify({ a: 1, written_by_claude: true }))
      },
    })
    expect(r.ok).toBe(true)
    const after = read()
    expect(after.written_by_claude).toBe(true)
    expect(after.mcpServers.plur).toEqual(ENTRY)
    expect(fired).toBeGreaterThanOrEqual(2)
  })

  it('L1/R1: changed again after the one re-apply → refused, naming Claude Code; left as the other writer left it', () => {
    writeFileSync(userPath, JSON.stringify({ a: 1 }))
    let n = 0
    const r = register({ _beforeWrite: () => { writeFileSync(userPath, JSON.stringify({ a: 1, n: ++n })) } })
    expect(r.ok).toBe(false)
    // Exactly one re-apply (#1564 re-review R1): fewer completed writes, fewer lost updates.
    expect(n).toBe(2)
    expect(r.message).toMatch(/Claude Code is writing .* right now/)
    expect(r.message).toMatch(/run plur init again/)
    expect(read().mcpServers).toBeUndefined()
    expect(backups()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('L4: a symlink to a missing file is named as such, not "run again"', () => {
    symlinkSync(join(dir, 'nowhere.json'), userPath)
    const r = register()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/symlink/)
    expect(r.message).not.toMatch(/run again/)
  })

  it('L4: a byte-order mark is accepted; the file is saved without one, its keys kept', () => {
    writeFileSync(userPath, '﻿' + JSON.stringify({ keep: 'me' }))
    const r = register()
    expect(r.ok).toBe(true)
    const raw = readFileSync(userPath, 'utf8')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
    expect(JSON.parse(raw)).toMatchObject({ keep: 'me', mcpServers: { plur: ENTRY } })
  })

  it('L5: an mcpServers that is not an object is refused, untouched, with no backup', () => {
    for (const bad of [[], 'x', 5, null]) {
      const text = JSON.stringify({ mcpServers: bad })
      writeFileSync(userPath, text)
      const r = register()
      expect(r.ok).toBe(false)
      expect(r.status).toBe('refused')
      expect(r.message).toMatch(/mcpServers/)
      expect(readFileSync(userPath, 'utf8')).toBe(text)
      expect(backups()).toEqual([])
    }
  })

  it('keeps at most the last 3 PLUR backups, each mode 0600, and leaves other files alone', () => {
    writeFileSync(join(dir, '.claude.json.backup'), 'not ours')
    for (let i = 0; i < 5; i++) {
      writeFileSync(userPath, JSON.stringify({ round: i }), { mode: 0o644 })
      const r = register()
      expect(r.ok).toBe(true)
    }
    const kept = backups()
    expect(kept).toHaveLength(3)
    expect(kept.map(b => JSON.parse(readFileSync(join(dir, b), 'utf8')).round).sort()).toEqual([2, 3, 4])
    if (process.platform !== 'win32') for (const b of kept) expect(statSync(join(dir, b)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, '.claude.json.backup'), 'utf8')).toBe('not ours')
  })
})
