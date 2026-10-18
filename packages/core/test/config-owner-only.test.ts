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
const { _atomicWriteAcl } = await import('../src/sync.js')
const { setSchemaVersion } = await import('../src/migrations/runner.js')
const { removePrimaryStoreEntries } = await import('../src/store-duplicates.js')

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
  const ok = (p: string) => ({ status: 0, stdout: `${p} ${ACCT}:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files` })

  it('icacls is called with an argument array that grants only the account', () => {
    const calls: string[][] = []
    const exec = (c: string, a: string[]) => { calls.push([c, ...a]); return { status: 0, stdout: 'C:\\h\\My Files\\.plur\\config.yaml ACME\\alice:(F)\n\nSuccessfully processed 1 files' } }
    expect(protectOwnerOnly('C:\\h\\My Files\\.plur\\config.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: true })
    expect(calls[0]).toEqual(['icacls', 'C:\\h\\My Files\\.plur\\config.yaml', '/inheritance:r', '/grant:r', 'ACME\\alice:F'])
    expect(calls[1]).toEqual(['icacls', 'C:\\h\\My Files\\.plur\\config.yaml'])
  })

  it('a folder gets an inheritable grant', () => {
    const calls: string[][] = []
    const exec = (c: string, a: string[]) => { calls.push([c, ...a]); return ok(a[0]) }
    expect(protectOwnerOnly('C:\\b', { platform: 'win32', exec, account: ACCT, directory: true })).toEqual({ ok: true })
    expect(calls[0]).toEqual(['icacls', 'C:\\b', '/inheritance:r', '/grant:r', 'ACME\\alice:(OI)(CI)F'])
  })

  it('another principal in the ACL → { ok:false, detail:"also readable by BUILTIN\\\\Users" }', () => {
    const exec = (_c: string, a: string[]) => a.length > 1
      ? { status: 0, stdout: '' }
      : { status: 0, stdout: `${a[0]} ACME\\alice:(F)\n         BUILTIN\\Users:(RX)\n\nSuccessfully processed 1 files` }
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
  })

  it('explicit grants that survive /inheritance:r are removed by name, then the list is read again (seen on a Windows runner)', () => {
    const calls: string[][] = []
    let removed = false
    const exec = (c: string, a: string[]) => {
      calls.push([c, ...a])
      if (a[1] === '/remove:g') { removed = true; return { status: 0, stdout: 'Successfully processed 1 files' } }
      if (a.length > 1) return { status: 0, stdout: '' }
      return { status: 0, stdout: removed
        ? `${a[0]} ACME\\alice:(F)\n\nSuccessfully processed 1 files`
        : `${a[0]} NT AUTHORITY\\SYSTEM:(F)\n    BUILTIN\\Administrators:(F)\n    ACME\\alice:(F)\n\nSuccessfully processed 1 files` }
    }
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: true })
    expect(calls).toEqual([
      ['icacls', 'C:\\c.yaml', '/inheritance:r', '/grant:r', 'ACME\\alice:F'],
      ['icacls', 'C:\\c.yaml'],
      ['icacls', 'C:\\c.yaml', '/remove:g', 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators'],
      ['icacls', 'C:\\c.yaml'],
    ])
  })

  it('a removal that fails → ok:false with its exit code', () => {
    const exec = (_c: string, a: string[]) => a[1] === '/remove:g'
      ? { status: 5, stdout: '' }
      : a.length > 1 ? { status: 0, stdout: '' } : { status: 0, stdout: `${a[0]} Everyone:(R)\n ACME\\alice:(F)\n` }
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'icacls failed (exit 5)' })
  })

  it('icacls exit 5 → { ok:false, detail:"icacls failed (exit 5)" }', () => {
    const exec = () => ({ status: 5, stdout: '' })
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: ACCT })).toEqual({ ok: false, detail: 'icacls failed (exit 5)' })
  })

  it('account unknown → ok:false (protect) / unknown (check)', () => {
    const exec = vi.fn(ok)
    expect(protectOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: null }).ok).toBe(false)
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec, account: null }).ok).toBe('unknown')
    expect(exec).not.toHaveBeenCalled()
  })

  it('checkOwnerOnly: a failed read or an output naming no account is unknown, never ok', () => {
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: () => ({ status: 5, stdout: '' }), account: ACCT }).ok).toBe('unknown')
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: () => ({ status: 0, stdout: 'Successfully processed 1 files' }), account: ACCT }).ok).toBe('unknown')
    const calls: string[][] = []
    expect(checkOwnerOnly('C:\\c.yaml', { platform: 'win32', exec: (c, a) => { calls.push([c, ...a]); return ok(a[0]) }, account: ACCT })).toEqual({ ok: true })
    expect(calls).toEqual([['icacls', 'C:\\c.yaml']])   // reads only
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
    calls = []
    protectedPaths = new Set()
    failGrant = false
    _atomicWriteAcl.platform = 'win32'
    _atomicWriteAcl.env = { USERNAME: 'alice', USERDOMAIN: 'CORP' }
    _atomicWriteAcl.exec = (cmd, args) => {
      calls.push([cmd, ...args])
      const p = args[0]
      if (args.length > 1) {
        if (failGrant) return { status: 5, stdout: '' }
        protectedPaths.add(p)
        return { status: 0, stdout: '' }
      }
      if (!realFs.existsSync(p)) return { status: 2, stdout: '' }
      return { status: 0, stdout: protectedPaths.has(p) ? `${p} CORP\\alice:(F)\n` : `${p} CORP\\alice:(F)\n BUILTIN\\Users:(RX)\n` }
    }
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
    expect(calls[grant]).toContain('CORP\\alice:F')
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
})

describe('no config writer bypasses it', () => {
  const read = (f: string) => realFs.readFileSync(join(SRC, f), 'utf8')
  it('index.ts has no atomicWrite(this.paths.config call left', () => {
    expect(read('index.ts')).not.toMatch(/atomicWrite\(this\.paths\.config/)
  })
  it('no source file passes CONFIG_FILE_MODE to atomicWrite except the shared helper', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of realFs.readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !p.endsWith(join('src', 'config-file.ts'))) {
          if (/atomicWrite\([^)]*CONFIG_FILE_MODE/.test(realFs.readFileSync(p, 'utf8'))) offenders.push(p)
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

  it('diagnostic: raw icacls bytes for a path that is not ASCII, /save output, whoami (printed to the log)', () => {
    const d = join(root, 'M\u00fcller \u010crt')
    realFs.mkdirSync(d)
    const f = join(d, 'diag.txt')
    realFs.writeFileSync(f, 'x')
    const raw = spawnSync('icacls', [f])
    console.log('[diag-enc] path ' + JSON.stringify(f) + ' exit ' + raw.status + ' bytes ' + raw.stdout.subarray(0, 200).toString('hex'))
    console.log('[diag-enc] utf8 ' + JSON.stringify(raw.stdout.toString('utf8')))
    const saved = join(root, 'acl.save')
    const sv = spawnSync('icacls', [f, '/save', saved])
    console.log('[diag-enc] /save exit ' + sv.status + (realFs.existsSync(saved) ? ' bytes ' + realFs.readFileSync(saved).toString('hex') : ' no file'))
    const who = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'])
    console.log('[diag-enc] whoami exit ' + who.status + ' ' + JSON.stringify(who.stdout.toString('utf8')))
    const cp = spawnSync('cmd', ['/d', '/c', 'chcp'])
    console.log('[diag-enc] chcp ' + JSON.stringify(cp.stdout.toString('utf8')))
  })

  it('a config.yaml in a folder whose name is not ASCII (a profile like C:\\Users\\M\u00fcller) is protected and verifies', () => {
    const d = join(root, 'M\u00fcller \u010crt')
    realFs.mkdirSync(d)
    const c = join(d, 'config.yaml')
    expect(writeConfigFile(c, 'stores: []\n')).toEqual({ ok: true })
    expect(checkOwnerOnly(c)).toEqual({ ok: true })
    realFs.writeFileSync(join(d, 'shared.txt'), 'x')
    expect(checkOwnerOnly(join(d, 'shared.txt')).ok).toBe(false)
  })

  it('a folder gets an owner-only, inheritable list', () => {
    const d = join(root, 'backups')
    realFs.mkdirSync(d)
    expect(protectOwnerOnly(d, { directory: true })).toEqual({ ok: true })
    for (const p of principals(d)) expect(p.toLowerCase()).toBe(currentWindowsAccount()!.toLowerCase())
  })
})
