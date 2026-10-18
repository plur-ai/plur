/**
 * #1631 (plan B Task 1b, audit finding 2): config.yaml holds the device key,
 * so it stays owner-only after EVERY core write — Unix 0600, Windows an
 * access list naming only the current account.
 *
 * Owner decisions applied (epic 1797 review, rows 38, 42 and 20):
 * - every config.yaml writer goes through one helper (`writeConfigFile`),
 *   which marks the write `secret`;
 * - on Windows a secret write makes its temporary file owner-only before the
 *   first byte — also for a NEW file and over a file other accounts can read —
 *   and refuses (writes nothing) when that cannot be established;
 * - the CLI's own owner-only helper is replaced by core's (`protectOwnerOnly`).
 *
 * What must break for each to fail: the rewrite tests fail if any config
 * writer skips writeConfigFile; the Windows real test fails if the access list
 * is not re-applied after the rename (the audit's finding); the static test
 * fails when a new writer is added the old way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as realFs from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import ts from 'typescript'

const chmodOff = vi.hoisted(() => ({ on: false, onRename: null as null | ((from: string, to: string) => void) }))
vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('fs')>()
  // "chmod that does nothing": a mount with fixed file modes (fmask=022) —
  // every file stays 0644 whatever mode is asked for.
  const chmodSync = ((p: any, m: any) => fs.chmodSync(p, chmodOff.on ? 0o644 : m)) as typeof fs.chmodSync
  // Observe each rename into place (the temp file's mode / access list).
  const renameSync = ((a: any, b: any) => { chmodOff.onRename?.(String(a), String(b)); return fs.renameSync(a, b) }) as typeof fs.renameSync
  return { ...fs, default: { ...fs, chmodSync, renameSync }, chmodSync, renameSync }
})

const { Plur, protectOwnerOnly, checkOwnerOnly, writeConfigFile, currentWindowsAccount } = await import('../src/index.js')
const { currentWindowsSid, _systemTool } = await import('../src/owner-only.js')
const { windowsSystemRoot, windowsSystemTool } = await import('../src/index.js')
const { _atomicWriteAcl, atomicWrite } = await import('../src/sync.js')
const { setSchemaVersion } = await import('../src/migrations/runner.js')
const { removePrimaryStoreEntries } = await import('../src/store-duplicates.js')
const { SELF, fakeAclExec, icaclsCalls } = await import('./helpers/fake-acl.js')

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const isWin = process.platform === 'win32'
const modeOf = (p: string) => realFs.statSync(p).mode & 0o777

let root: string
let cfg: string
beforeEach(() => {
  root = realFs.mkdtempSync(join(tmpdir(), 'plur-config-owner-only-'))
  cfg = join(root, 'config.yaml')
  chmodOff.on = false
})
afterEach(() => {
  chmodOff.on = false
  chmodOff.onRename = null
  vi.restoreAllMocks()
  realFs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(isWin)('Unix: config.yaml is 0600 after every core write', () => {
  it('a 0644 config.yaml is 0600 after a store write, and stays 0600 after a rewrite', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    realFs.chmodSync(cfg, 0o644)
    const plur = new Plur({ path: root })
    plur.addStore('', 'group:acme/team', { url: 'https://plur.example.com', token: 't' })
    expect(modeOf(cfg)).toBe(0o600)
    plur.addStore('', 'group:acme/other', { url: 'https://plur.example.com', token: 't' })
    expect(modeOf(cfg)).toBe(0o600)
  })

  it('every writer: identity, dismissed scopes, schema version, duplicate removal', () => {
    const plur = new Plur({ path: root })
    const widen = () => realFs.chmodSync(cfg, 0o644)

    realFs.writeFileSync(cfg, 'stores: []\n'); widen()
    plur.setIdentity('local:alice')
    expect(modeOf(cfg)).toBe(0o600)

    widen()
    plur.dismissScope('group:acme/noise')
    expect(modeOf(cfg)).toBe(0o600)

    widen()
    setSchemaVersion(cfg, 5)
    expect(modeOf(cfg)).toBe(0o600)

    const primary = join(root, 'engrams.yaml')
    realFs.writeFileSync(cfg, `stores:\n  - path: ${primary}\n    scope: project:dup\n`); widen()
    removePrimaryStoreEntries(cfg, primary)
    expect(modeOf(cfg)).toBe(0o600)
  })

  it('a new config.yaml is born 0600 (writeConfigFile)', () => {
    expect(writeConfigFile(cfg, 'stores: []\n')).toEqual({ ok: true })
    expect(modeOf(cfg)).toBe(0o600)
  })

  it('the new content never lands at the old wider mode (tightened before the write)', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    realFs.chmodSync(cfg, 0o644)
    const seen: number[] = []
    chmodOff.onRename = (a, b) => { if (b === cfg) seen.push(realFs.statSync(a).mode & 0o777) }
    writeConfigFile(cfg, 'stores: []\ntoken: new\n')
    expect(seen.length).toBe(1)
    for (const m of seen) expect(m & 0o077).toBe(0)
    expect(modeOf(cfg)).toBe(0o600)
  })

  it('chmod that does nothing (fixed-mode mount) → { ok:false, detail:"mode is 644, expected 600" } and one stderr line', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    realFs.chmodSync(cfg, 0o644)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    chmodOff.on = true
    const r = writeConfigFile(cfg, 'stores: []\nindex: false\n')
    chmodOff.on = false
    expect(r).toEqual({ ok: false, detail: 'mode is 644, expected 600' })
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toBe('[plur:config] could not restrict config.yaml to your account: mode is 644, expected 600')
    // The write itself stands — losing the key would be worse.
    expect(realFs.readFileSync(cfg, 'utf8')).toBe('stores: []\nindex: false\n')
  })

  it('checkOwnerOnly only reads: 0600 → ok, 0644 → ok:false, missing → unknown', () => {
    realFs.writeFileSync(cfg, 'x\n')
    realFs.chmodSync(cfg, 0o600)
    expect(checkOwnerOnly(cfg)).toEqual({ ok: true })
    realFs.chmodSync(cfg, 0o644)
    expect(checkOwnerOnly(cfg)).toEqual({ ok: false, detail: 'mode is 644, expected 600' })
    expect(modeOf(cfg)).toBe(0o644)
    expect(checkOwnerOnly(join(root, 'nope.yaml')).ok).toBe('unknown')
  })

  it('protectOwnerOnly on a folder: 0700', () => {
    const d = join(root, 'backups')
    realFs.mkdirSync(d, { mode: 0o755 })
    realFs.chmodSync(d, 0o755)
    expect(protectOwnerOnly(d, { directory: true })).toEqual({ ok: true })
    expect(modeOf(d)).toBe(0o700)
  })
})

describe('Windows (fake exec): protectOwnerOnly / checkOwnerOnly', () => {
  const ACCT = 'ACME\\alice'
  const P = 'C:\\h\\My Files\\.plur\\config.yaml'

  it('icacls is called with an argument array that grants only the account, by its SID', () => {
    const { exec, calls } = fakeAclExec({ acl: () => [SELF] })
    expect(protectOwnerOnly(P, { platform: 'win32', exec, account: ACCT })).toEqual({ ok: true })
    expect(calls[0]).toEqual(['whoami', '/user', '/fo', 'csv', '/nh'])
    expect(calls[1]).toEqual(['icacls', P, '/inheritance:r', '/grant:r', `*${SELF}:F`])
    expect(icaclsCalls(calls)[1]).toEqual(['icacls', P, '/save'])
    expect(calls).toHaveLength(3)
  })

  it('a folder gets an inheritable grant', () => {
    const { exec, calls } = fakeAclExec({ acl: () => [SELF] })
    expect(protectOwnerOnly('C:\\b', { platform: 'win32', exec, account: ACCT, directory: true })).toEqual({ ok: true })
    expect(icaclsCalls(calls)[0]).toEqual(['icacls', 'C:\\b', '/inheritance:r', '/grant:r', `*${SELF}:(OI)(CI)F`])
  })

  it('another principal in the ACL that cannot be removed → { ok:false, detail:"also readable by BUILTIN\\\\Users" }', () => {
    const { exec } = fakeAclExec({ acl: () => [SELF, 'BU'], remove: () => 0 })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
  })

  it('explicit grants that survive /inheritance:r are removed by SID, then the list is read again (seen on a Windows runner)', () => {
    let removed = false
    const { exec, calls } = fakeAclExec({
      acl: () => removed ? [SELF] : ['SY', 'BA', SELF],
      remove: () => { removed = true; return 0 },
    })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: true })
    expect(icaclsCalls(calls)).toEqual([
      ['icacls', 'C:\\c.yaml', '/inheritance:r', '/grant:r', `*${SELF}:F`],
      ['icacls', 'C:\\c.yaml', '/save'],
      ['icacls', 'C:\\c.yaml', '/remove', '*S-1-5-18', '*S-1-5-32-544'],
      ['icacls', 'C:\\c.yaml', '/save'],
    ])
  })

  it('every non-owner principal is removed: Users, Authenticated Users, Everyone, CREATOR OWNER, another account', () => {
    const other = 'S-1-5-21-1111-2222-3333-1002'
    const sidOf: Record<string, string> = { BU: 'S-1-5-32-545', AU: 'S-1-5-11', WD: 'S-1-1-0', CO: 'S-1-3-0' }
    let left = ['BU', 'AU', 'WD', 'CO', other, SELF]
    const { exec, calls } = fakeAclExec({
      acl: () => left,
      remove: (_p, sids) => { left = left.filter(t => !sids.includes(`*${sidOf[t] ?? t}`)); return 0 },
    })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: true })
    expect(icaclsCalls(calls)[2]).toEqual(['icacls', 'C:\\c.yaml', '/remove', '*S-1-5-32-545', '*S-1-5-11', '*S-1-1-0', '*S-1-3-0', `*${other}`])
    expect(left).toEqual([SELF])
  })

  it('a principal that cannot be named by SID (a domain-relative abbreviation) is not removed: refused, nothing guessed', () => {
    const { exec, calls } = fakeAclExec({ acl: () => [SELF, 'DA'] })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'also readable by DA (cannot remove DA)' })
    expect(calls.some(c => c.includes('/remove'))).toBe(false)
  })

  it('the built-in Administrator account (RID 500) is listed as LA: it is the owner when the SID ends in -500', () => {
    const admin = 'S-1-5-21-1111-2222-3333-500'
    const { exec } = fakeAclExec({ acl: () => ['LA'], whoami: () => ({ status: 0, stdout: `"host\\runneradmin","${admin}"\r\n` }) })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: 'host\\runneradmin' })).toEqual({ ok: true })
    const { exec: exec2 } = fakeAclExec({ acl: () => ['LA', SELF] })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: exec2, account: ACCT })).toEqual({ ok: false, detail: 'also readable by LA' })
  })

  it('a null access list (everyone) is not owner-only; an empty one or an unreadable entry is unknown', () => {
    const saving = (sddl: string) => (c: string, a: string[]) => {
      if (c === 'whoami') return { status: 0, stdout: `"ACME\\alice","${SELF}"` }
      realFs.writeFileSync(a[2], Buffer.from(`name.yaml\r\n${sddl}\r\n`, 'utf16le'))
      return { status: 0, stdout: '' }
    }
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving('D:NO_ACCESS_CONTROL'), account: ACCT })).toEqual({ ok: false, detail: 'also readable by Everyone' })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving('D:PAI'), account: ACCT }).ok).toBe('unknown')
    // A conditional entry (nested parentheses) could hide an entry behind it.
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(`D:PAI(A;;FA;;;${SELF})(XA;;FA;;;${SELF};(@User.x == 1))(A;;FA;;;BU)`), account: ACCT }).ok).toBe('unknown')
    // UTF-8 is read too, and a SACL after the list is not an entry.
    const utf8 = (c: string, a: string[]) => {
      if (c === 'whoami') return { status: 0, stdout: `"ACME\\alice","${SELF}"` }
      realFs.writeFileSync(a[2], `name.yaml\nD:PAI(A;;FA;;;${SELF})S:(ML;;NW;;;LW)\n`)
      return { status: 0, stdout: '' }
    }
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: utf8, account: ACCT })).toEqual({ ok: true })
    // UTF-16 whose name line starts with a character above U+00FF (no zero second byte).
    const wide = (c: string, a: string[]) => {
      if (c === 'whoami') return { status: 0, stdout: `"ACME\\alice","${SELF}"` }
      realFs.writeFileSync(a[2], Buffer.from(`\u010crt.yaml\r\nD:PAI(A;;FA;;;${SELF})(A;;FA;;;BU)\r\n`, 'utf16le'))
      return { status: 0, stdout: '' }
    }
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: wide, account: ACCT })).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
    // UTF-16 with a long name in a script with no zero bytes at all (Codex gate round 1).
    const longName = (c: string, a: string[]) => {
      if (c === 'whoami') return { status: 0, stdout: `"ACME\\alice","${SELF}"` }
      realFs.writeFileSync(a[2], Buffer.from(`${'\u754c'.repeat(200)}.yaml\r\nD:PAI(A;;FA;;;${SELF})\r\n`, 'utf16le'))
      return { status: 0, stdout: '' }
    }
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: longName, account: ACCT })).toEqual({ ok: true })
  })

  it('a saved list that is not exactly one well-formed descriptor is unknown, never ok (Codex gate round 1)', () => {
    const saving = (body: string) => (c: string, a: string[]) => {
      if (c === 'whoami') return { status: 0, stdout: `"ACME\\alice","${SELF}"` }
      realFs.writeFileSync(a[2], Buffer.from(`name.yaml\r\n${body}\r\n`, 'utf16le'))
      return { status: 0, stdout: '' }
    }
    for (const body of [
      `D:PAI(A;;FA;;;${SELF}) (A;;FA;;;WD)`,                 // an entry after a space
      `D:PAI(A;;FA;;;${SELF})\r\nD:NO_ACCESS_CONTROL`,       // a second descriptor
      `D:PAI(A;;FA;;;${SELF})\r\nother.yaml\r\nD:PAI(A;;FA;;;WD)`, // a second record
      `D:PAI(A;;FA;;;${SELF})junk`,                           // trailing text
      `D:PAI(A;;FA;;;${SELF})D:PAI(A;;FA;;;WD)`,              // two D: sections
    ]) {
      expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(body), account: ACCT }).ok, body).toBe('unknown')
    }
    // A descriptor whose list flags or entries are not SDDL (Codex gate round 2).
    for (const body of [
      `D:GARBAGE(A;;FA;;;${SELF})`,
      `D:PAI(bogus;;;;;${SELF})`,
      `D:PAI(A;;FA;;${SELF})`,                                // five fields
      `D:PAI(A;;FA;;;;${SELF})`,                              // seven fields
      `D:PAI(A;XX;FA;;;${SELF})`,                             // unknown entry flag
      `D:PAI(A;;fa;;;${SELF})`,                               // rights not SDDL
      `D:PAI(A;;ZZ;;;${SELF})`,                               // no such right (Codex gate round 3)
      `D:PAI(A;;GARBAGEZ;;;${SELF})`,
      `D:PAI(A;;0x123456789;;;${SELF})`,                      // wider than an access mask
      `D:PAI(A;;FA;not-a-guid;;${SELF})`,
      `D:PAI(A;;FA;;;nobody)`,
    ]) {
      expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(body), account: ACCT }).ok, body).toBe('unknown')
    }
    // Well-formed variants are still read: owner and group sections, a SACL, entry flags,
    // hex rights, an inherited entry, a deny entry for another account (not owner-only).
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(`D:PAI(A;OICIID;0x1F01FF;;;${SELF})`), account: ACCT })).toEqual({ ok: true })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(`D:PAI(A;;FRFWRCSD;;;${SELF})(A;OICIIO;GA;;;${SELF})`), account: ACCT })).toEqual({ ok: true })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(`D:AI(A;ID;FA;;;${SELF})(D;;FA;;;BU)`), account: ACCT })).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: saving(`O:${SELF}G:SYD:PAI(A;;FA;;;${SELF})S:AI(ML;;NW;;;LW)`), account: ACCT })).toEqual({ ok: true })
  })

  it('a removal that fails → ok:false with its exit code', () => {
    const { exec } = fakeAclExec({ acl: () => ['WD', SELF], remove: () => 5 })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'icacls failed (exit 5)' })
  })

  it('icacls exit 5 → { ok:false, detail:"icacls failed (exit 5)" }', () => {
    const { exec } = fakeAclExec({ acl: () => [SELF], grant: () => 5 })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'icacls failed (exit 5)' })
  })

  it('account unknown → ok:false (protect) / unknown (check), nothing run', () => {
    const { exec, calls } = fakeAclExec({ acl: () => [SELF] })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: null }).ok).toBe(false)
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: null }).ok).toBe('unknown')
    expect(calls).toEqual([])
  })

  it('the account SID unknown (whoami fails or names none) → ok:false (protect) / unknown (check), no icacls', () => {
    for (const whoami of [() => ({ status: 1, stdout: '' }), () => ({ status: 0, stdout: '"ACME\\alice","not-a-sid"' })]) {
      const { exec, calls } = fakeAclExec({ acl: () => [SELF], whoami })
      expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'the Windows account is not known (whoami named no SID)' })
      expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT }).ok).toBe('unknown')
      expect(calls.some(c => c[0] === 'icacls')).toBe(false)
    }
  })

  it('checkOwnerOnly: a failed read is unknown, never ok; it only reads', () => {
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: fakeAclExec({ acl: () => null }).exec, account: ACCT }).ok).toBe('unknown')
    const { exec, calls } = fakeAclExec({ acl: () => [SELF] })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: true })
    expect(icaclsCalls(calls)).toEqual([['icacls', 'C:\\c.yaml', '/save']])   // reads only
  })

  it('the /save file is removed after reading', () => {
    const { exec, calls } = fakeAclExec({ acl: () => [SELF] })
    checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })
    const saved = calls.find(c => c[2] === '/save')![3]
    expect(realFs.existsSync(saved)).toBe(false)
  })

  it('icacls and whoami run by full path from %SystemRoot%\\System32 (never a planted copy); other names unchanged', () => {
    expect(_systemTool('icacls', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\icacls.exe')
    expect(_systemTool('whoami', { SystemRoot: 'd:\\WINDOWS' })).toBe('d:\\WINDOWS\\System32\\whoami.exe')
    // Only `<drive>:\Windows` is trusted (the rule the company-CA install uses): a SystemRoot
    // pointing anywhere else runs nothing on Windows.
    for (const SystemRoot of ['', '.', 'Windows', 'C:\\Users\\Public\\evil', '\\\\evil\\share\\Windows', 'C:\\Windows\\..\\Users\\x', 'C:\\Win"dows', 'C:\\Windows\n', 'D:\\Win']) {
      expect(_systemTool('icacls', { SystemRoot }, true), SystemRoot).toBeNull()
      expect(windowsSystemTool('whoami', { SystemRoot }), SystemRoot).toBeNull()
    }
    expect(windowsSystemTool('icacls', { SystemRoot: 'E:\\Windows' })).toBe('E:\\Windows\\System32\\icacls.exe')
    expect(windowsSystemRoot({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows')
    expect(windowsSystemRoot({})).toBeNull()
    expect(_systemTool('icacls', {}, false)).toBe('icacls')   // not Windows (the test stub's fake on PATH)
    // Real Windows with no SystemRoot/windir in the environment: nothing is run by bare
    // name (Windows searches the working folder first) — the protection fails closed.
    expect(_systemTool('icacls', {}, true)).toBeNull()
    expect(_systemTool('whoami', {}, true)).toBeNull()
    expect(_systemTool('git', { SystemRoot: 'C:\\Windows' })).toBe('git')
  })

  it('currentWindowsAccount is DOMAIN\\user, or null without USERNAME', () => {
    expect(currentWindowsAccount({ USERDOMAIN: 'ACME', USERNAME: 'alice' })).toBe('ACME\\alice')
    expect(currentWindowsAccount({ USERNAME: 'alice' })).toBe('alice')
    expect(currentWindowsAccount({})).toBeNull()
  })
})

describe('Windows (simulated host): every config write is a protected write', () => {
  let saved: typeof _atomicWriteAcl
  let calls: string[][]
  /** Paths icacls made owner-only; everything else reads as inherited (shared). */
  let protectedPaths: Set<string>
  let failGrant: boolean

  beforeEach(() => {
    saved = { ..._atomicWriteAcl }
    protectedPaths = new Set()
    failGrant = false
    const fake = fakeAclExec({
      acl: p => realFs.existsSync(p) ? (protectedPaths.has(p) ? [SELF] : [SELF, 'BU']) : null,
      grant: p => { if (failGrant) return 5; protectedPaths.add(p); return 0 },
      remove: () => 0,
    })
    calls = fake.calls
    _atomicWriteAcl.platform = 'win32'
    _atomicWriteAcl.env = { USERNAME: 'alice', USERDOMAIN: 'CORP' }
    _atomicWriteAcl.exec = fake.exec
  })
  afterEach(() => { Object.assign(_atomicWriteAcl, saved) })

  /** The rename moves the temp file's list onto config.yaml: follow it. */
  const followRenames = () => {
    chmodOff.onRename = (a, b) => { if (protectedPaths.has(a)) protectedPaths.add(b); else protectedPaths.delete(b) }
  }

  it('a NEW config.yaml: the temp file is owner-only before the first byte, and the result verifies', () => {
    followRenames()
    expect(writeConfigFile(cfg, 'stores: []\n')).toEqual({ ok: true })
    const grant = calls.findIndex(c => c.includes('/inheritance:r'))
    expect(grant).toBeGreaterThanOrEqual(0)
    expect(calls[grant][1]).toMatch(/config\.yaml\.\d+\.\d+\.tmp$/)
    expect(calls[grant]).toContain(`*${SELF}:F`)
    expect(protectedPaths.has(cfg)).toBe(true)
  })

  it('a config.yaml other accounts can read is made owner-only by the next store write', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    followRenames()
    const plur = new Plur({ path: root })
    plur.addStore('', 'group:acme/team', { url: 'https://plur.example.com', token: 't' })
    expect(protectedPaths.has(cfg)).toBe(true)
    plur.addStore('', 'group:acme/other', { url: 'https://plur.example.com', token: 't' })
    expect(protectedPaths.has(cfg)).toBe(true)
  })

  it('protection that cannot be established: the write is refused and config.yaml is unchanged', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    followRenames()
    failGrant = true
    const plur = new Plur({ path: root })
    expect(() => plur.addStore('', 'group:acme/team', { url: 'https://plur.example.com', token: 'secret-key' })).toThrow(/owner-only/)
    expect(realFs.readFileSync(cfg, 'utf8')).toBe('stores: []\n')
    expect(realFs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('an access list that cannot be inspected: refused, nothing written', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    _atomicWriteAcl.exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: null, stdout: '' } }
    expect(() => setSchemaVersion(cfg, 9)).toThrow()
    expect(realFs.readFileSync(cfg, 'utf8')).toBe('stores: []\n')
  })

  it('Windows account unknown and no config yet: refused, no file created', () => {
    _atomicWriteAcl.env = {}
    expect(() => writeConfigFile(cfg, 'token: x\n')).toThrow(/account is not known/)
    expect(realFs.existsSync(cfg)).toBe(false)
  })

  it('a temp file whose list reads back malformed is not protected: the write is refused before any byte (Codex gate round 3)', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    _atomicWriteAcl.exec = (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'whoami') return { status: 0, stdout: `"CORP\\alice","${SELF}"` }
      if (args[1] === '/save') {
        realFs.writeFileSync(args[2], Buffer.from(`n\r\nD:PAI(A;;${/\.tmp$/.test(args[0]) ? 'ZZ' : 'FA'};;;${SELF})\r\n`, 'utf16le'))
        return { status: 0, stdout: '' }
      }
      return { status: 0, stdout: '' }
    }
    expect(() => writeConfigFile(cfg, 'token: x\n')).toThrow(/refusing a credential write/)
    expect(realFs.readFileSync(cfg, 'utf8')).toBe('stores: []\n')
    expect(realFs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('a refusal is one line that names the cause and the opt-out', () => {
    realFs.writeFileSync(cfg, 'stores: []\n')
    _atomicWriteAcl.exec = () => ({ status: 1, stdout: '' })   // a drive without access lists: icacls fails
    let msg = ''
    try { writeConfigFile(cfg, 'token: x\n') } catch (e) { msg = (e as Error).message }
    expect(msg).not.toContain('\n')
    expect(msg).toMatch(/cannot inspect the destination's access list/)
    expect(msg).toMatch(/Nothing was written/)
    expect(msg).toContain('PLUR_ALLOW_UNPROTECTED_CONFIG=1')
  })

  describe('PLUR_ALLOW_UNPROTECTED_CONFIG (a drive that cannot keep access lists)', () => {
    const noAcl = () => { _atomicWriteAcl.exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: 1, stdout: '' } } }

    for (const v of ['1', 'true', 'YES']) {
      it(`set to ${v}: an existing config.yaml is written without protection, and one stderr line says so`, () => {
        realFs.writeFileSync(cfg, 'stores: []\n')
        noAcl()
        _atomicWriteAcl.env = { USERNAME: 'alice', USERDOMAIN: 'CORP', PLUR_ALLOW_UNPROTECTED_CONFIG: v }
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        const r = writeConfigFile(cfg, 'token: x\n')
        expect(r.ok).toBe(false)
        expect(realFs.readFileSync(cfg, 'utf8')).toBe('token: x\n')
        const lines = err.mock.calls.map(c => String(c[0]))
        // One line (the temp file is still tried, and fails: no access lists on this drive).
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/^\[plur:config\] wrote config\.yaml WITHOUT owner-only protection \(PLUR_ALLOW_UNPROTECTED_CONFIG is set\): /)
        expect(lines[0]).not.toContain('\n')
      })
    }

    it('set: the temp file could not be protected but the file in place could — still one line (Codex gate round 2)', () => {
      realFs.writeFileSync(cfg, 'stores: []\n')
      followRenames()
      // The grant fails on temp files only; the file in place takes it.
      const fake = fakeAclExec({
        acl: p => realFs.existsSync(p) ? (protectedPaths.has(p) ? [SELF] : [SELF, 'BU']) : null,
        grant: p => { if (/\.tmp$/.test(p)) return 5; protectedPaths.add(p); return 0 },
      })
      _atomicWriteAcl.exec = fake.exec
      _atomicWriteAcl.env = { USERNAME: 'alice', PLUR_ALLOW_UNPROTECTED_CONFIG: '1' }
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(writeConfigFile(cfg, 'token: x\n')).toEqual({ ok: true })
      expect(protectedPaths.has(cfg)).toBe(true)
      expect(err).toHaveBeenCalledTimes(1)
      expect(String(err.mock.calls[0][0])).toMatch(/^\[plur:config\] wrote config\.yaml WITHOUT owner-only protection \(PLUR_ALLOW_UNPROTECTED_CONFIG is set\): /)
    })

    it('set: a NEW config.yaml whose temp file cannot be protected is written', () => {
      noAcl()
      _atomicWriteAcl.env = { USERNAME: 'alice', PLUR_ALLOW_UNPROTECTED_CONFIG: '1' }
      vi.spyOn(console, 'error').mockImplementation(() => {})
      writeConfigFile(cfg, 'token: x\n')
      expect(realFs.readFileSync(cfg, 'utf8')).toBe('token: x\n')
      expect(realFs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
    })

    it('set, the destination\'s list cannot be read but the temp file can be protected: it is protected, nothing reported', () => {
      realFs.writeFileSync(cfg, 'stores: []\n')
      const fake = fakeAclExec({
        acl: p => p === cfg ? null : realFs.existsSync(p) ? (protectedPaths.has(p) ? [SELF] : [SELF, 'BU']) : null,
        grant: p => { protectedPaths.add(p); return 0 },
      })
      _atomicWriteAcl.exec = fake.exec
      _atomicWriteAcl.env = { USERNAME: 'alice', PLUR_ALLOW_UNPROTECTED_CONFIG: '1' }
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      atomicWrite(cfg, 'token: x\n', { mode: 0o600, secret: true })
      expect(realFs.readFileSync(cfg, 'utf8')).toBe('token: x\n')
      expect(fake.calls.some(c => c[2] === '/inheritance:r' && /\.tmp$/.test(c[1]))).toBe(true)
      expect(err).not.toHaveBeenCalled()
    })

    it('set: protection that works is still applied (the opt-out only covers a failure)', () => {
      followRenames()
      _atomicWriteAcl.env = { USERNAME: 'alice', USERDOMAIN: 'CORP', PLUR_ALLOW_UNPROTECTED_CONFIG: '1' }
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(writeConfigFile(cfg, 'stores: []\n')).toEqual({ ok: true })
      expect(protectedPaths.has(cfg)).toBe(true)
      expect(err).not.toHaveBeenCalled()
    })

    for (const v of ['0', 'false', '', 'no']) {
      it(`set to "${v}": still refused`, () => {
        realFs.writeFileSync(cfg, 'stores: []\n')
        noAcl()
        _atomicWriteAcl.env = { USERNAME: 'alice', PLUR_ALLOW_UNPROTECTED_CONFIG: v }
        expect(() => writeConfigFile(cfg, 'token: x\n')).toThrow(/refusing a credential write/)
        expect(realFs.readFileSync(cfg, 'utf8')).toBe('stores: []\n')
      })
    }
  })
})

describe('no config writer bypasses it', () => {
  const read = (f: string) => realFs.readFileSync(join(SRC, f), 'utf8')
  it('index.ts has no atomicWrite(this.paths.config call left', () => {
    expect(read('index.ts')).not.toMatch(/atomicWrite\(this\.paths\.config/)
  })
  /** Every `atomicWrite(...)` call (TypeScript parser) whose arguments name CONFIG_FILE_MODE. */
  const callsWithConfigMode = (src: string): string[] => {
    const found: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && /(^|\.)atomicWrite$/.test(n.expression.getText(file).replace(/\s+/g, ''))
        && n.arguments.some(a => a.getText(file).includes('CONFIG_FILE_MODE'))) found.push(n.getText(file))
      ts.forEachChild(n, visit)
    }
    const file = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true)
    visit(file)
    return found
  }
  it('the guard sees a bypass with nested calls in its arguments (Codex gate round 1)', () => {
    expect(callsWithConfigMode('atomicWrite(configPath, yaml.dump(data), { mode: CONFIG_FILE_MODE })')).toHaveLength(1)
    expect(callsWithConfigMode('atomicWrite(p, yaml.dump(x, { a: f(1) }),\n  { mode: CONFIG_FILE_MODE, durable: true })')).toHaveLength(1)
    expect(callsWithConfigMode('atomicWrite(p, yaml.dump(x)); const m = CONFIG_FILE_MODE')).toHaveLength(0)
    // Codex gate round 2: a parenthesis inside a string, a space before the call, a namespace.
    expect(callsWithConfigMode("atomicWrite(configPath, yaml.dump({ marker: ')' }), { mode: CONFIG_FILE_MODE })")).toHaveLength(1)
    expect(callsWithConfigMode('atomicWrite (configPath, yaml.dump(data), { mode: CONFIG_FILE_MODE })')).toHaveLength(1)
    expect(callsWithConfigMode('sync.atomicWrite(configPath, data, { mode: sync.CONFIG_FILE_MODE })')).toHaveLength(1)
  })
  it('no source file passes CONFIG_FILE_MODE to atomicWrite except the shared helper', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of realFs.readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !p.endsWith(join('src', 'config-file.ts'))) {
          if (callsWithConfigMode(realFs.readFileSync(p, 'utf8')).length > 0) offenders.push(p)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
    expect(read('store-duplicates.ts')).not.toMatch(/atomicWrite\(configPath/)
    expect(read(join('migrations', 'runner.ts'))).not.toMatch(/atomicWrite\(configPath/)
  })
})

describe.runIf(isWin)('Windows, real icacls', () => {
  const principals = (p: string): string[] => {
    const out = spawnSync('icacls', [p], { encoding: 'utf8' }).stdout
    return out.split(/\r?\n/).map((l, i) => (i === 0 ? l.slice(p.length) : l).trim())
      .filter(t => t && !/^Successfully processed/i.test(t) && !/^Failed processing/i.test(t))
      .map(t => /^(.+?):\(/.exec(t)?.[1]).filter((x): x is string => !!x)
  }

  it('diagnostic: the access list a new file gets, and after protection (printed to the log)', () => {
    const f = join(root, 'diag.txt')
    realFs.writeFileSync(f, 'x')
    console.log('[diag] new file:\n' + spawnSync('icacls', [f], { encoding: 'utf8' }).stdout)
    const r = protectOwnerOnly(f)
    console.log('[diag] after protectOwnerOnly ' + JSON.stringify(r) + ':\n' + spawnSync('icacls', [f], { encoding: 'utf8' }).stdout)
    expect(r).toEqual({ ok: true })
  })

  it('after two core rewrites the ACL lists only the current account', () => {
    const acct = currentWindowsAccount()!
    expect(acct).toBeTruthy()
    realFs.writeFileSync(cfg, yaml.dump({ stores: [] }))
    // Before: inherited from the temp folder — other principals.
    const plur = new Plur({ path: root })
    plur.addStore('', 'group:acme/team', { url: 'https://plur.example.com', token: 't' })
    plur.addStore('', 'group:acme/other', { url: 'https://plur.example.com', token: 't' })
    const ps = principals(cfg)
    expect(ps.length).toBeGreaterThan(0)
    for (const p of ps) expect(p.toLowerCase()).toBe(acct.toLowerCase())
    expect(checkOwnerOnly(cfg)).toEqual({ ok: true })
    expect((yaml.load(realFs.readFileSync(cfg, 'utf8')) as { stores: unknown[] }).stores.length).toBe(2)
  })

  it('a new config.yaml is owner-only, and checkOwnerOnly sees a shared file', () => {
    expect(writeConfigFile(cfg, 'stores: []\n')).toEqual({ ok: true })
    for (const p of principals(cfg)) expect(p.toLowerCase()).toBe(currentWindowsAccount()!.toLowerCase())
    const shared = join(root, 'shared.txt')
    realFs.writeFileSync(shared, 'x')
    expect(checkOwnerOnly(shared).ok).toBe(false)
  })

  // icacls prints names and paths in the OEM code page (measured on the
  // runner: `ü` → byte 0x81, `Č` → `C`), so text matching refused every write
  // under such a folder. The list is now read as SDDL with SIDs.
  it('a config.yaml in a folder whose name is not ASCII (a profile like C:\\Users\\M\u00fcller) is protected and verifies', () => {
    const d = join(root, 'M\u00fcller \u010crt')
    realFs.mkdirSync(d)
    const c = join(d, 'config.yaml')
    expect(writeConfigFile(c, 'stores: []\n')).toEqual({ ok: true })
    expect(checkOwnerOnly(c)).toEqual({ ok: true })
    realFs.writeFileSync(join(d, 'shared.txt'), 'x')
    expect(checkOwnerOnly(join(d, 'shared.txt')).ok).toBe(false)
  })

  it('the account is identified by its SID (whoami)', () => {
    expect(currentWindowsSid()).toMatch(/^S-1-5-\d+(-\d+)+$/)
  })

  it('a planted icacls.exe in the working folder is never run', () => {
    const planted = join(root, 'planted')
    realFs.mkdirSync(planted)
    // Any other program under the name: if it ran, the protection could not verify.
    realFs.copyFileSync(join(process.env.SystemRoot!, 'System32', 'whoami.exe'), join(planted, 'icacls.exe'))
    const before = process.cwd()
    process.chdir(planted)
    try {
      expect(writeConfigFile(cfg, 'stores: []\n')).toEqual({ ok: true })
    } finally {
      process.chdir(before)
    }
  })

  it('a folder gets an owner-only, inheritable list', () => {
    const d = join(root, 'backups')
    realFs.mkdirSync(d)
    expect(protectOwnerOnly(d, { directory: true })).toEqual({ ok: true })
    for (const p of principals(d)) expect(p.toLowerCase()).toBe(currentWindowsAccount()!.toLowerCase())
  })
})
