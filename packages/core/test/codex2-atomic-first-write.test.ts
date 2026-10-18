/**
 * Codex round 2, finding 3: atomicWrite must protect its temporary file BEFORE
 * the first content byte, not only before the rename.
 *
 * The old helper opened the temp file with the default mode (0666 & ~umask =
 * 0644 under umask 022), wrote and fsynced the content, and only then chmodded
 * it to the destination's 0600. For that window the secret sat in a file any
 * local account could open — and a descriptor opened in the window stays
 * readable after the chmod. Final-mode tests cannot see that, so these tests
 * record the temp file's mode (and, for Windows, the access-list calls) at the
 * moment each content write happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as realFs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type WriteEvent = { kind: 'write'; target: string; mode: number }
type Event = WriteEvent | { kind: 'acl'; args: string[] }

const rec = vi.hoisted(() => ({ events: [] as Event[], on: false }))

vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('fs')>()
  const isFd = (x: unknown): x is number => typeof x === 'number'
  const writeFileSync = ((file: any, data: any, opts?: any) => {
    if (!rec.on) return fs.writeFileSync(file, data, opts)
    if (isFd(file)) {
      // The mode the bytes are about to land in.
      rec.events.push({ kind: 'write', target: `fd:${file}`, mode: fs.fstatSync(file).mode & 0o777 })
      return fs.writeFileSync(file, data, opts)
    }
    // Path form: the file is created by this very call, so its mode right
    // after the call is the mode the bytes landed in.
    const r = fs.writeFileSync(file, data, opts)
    rec.events.push({ kind: 'write', target: String(file), mode: fs.statSync(file).mode & 0o777 })
    return r
  }) as typeof fs.writeFileSync
  const writeSync = ((fd: number, ...rest: any[]) => {
    if (rec.on) rec.events.push({ kind: 'write', target: `fd:${fd}`, mode: fs.fstatSync(fd).mode & 0o777 })
    return (fs.writeSync as any)(fd, ...rest)
  }) as typeof fs.writeSync
  return { ...fs, default: { ...fs, writeFileSync, writeSync }, writeFileSync, writeSync }
})

const { atomicWrite, CONFIG_FILE_MODE, _atomicWriteAcl } = await import('../src/sync.js')

const isPosix = process.platform !== 'win32'
let root: string
let oldUmask: number

beforeEach(() => {
  root = realFs.mkdtempSync(join(tmpdir(), 'plur-codex2-atomic-'))
  rec.events = []
  rec.on = false
})
afterEach(() => {
  rec.on = false
  realFs.rmSync(root, { recursive: true, force: true })
})

const writes = () => rec.events.filter((e): e is WriteEvent => e.kind === 'write')
const modeOf = (p: string) => realFs.statSync(p).mode & 0o777

describe.skipIf(!isPosix)('atomicWrite protects the temp file before the first content write (POSIX)', () => {
  beforeEach(() => { oldUmask = process.umask(0o022) })
  afterEach(() => { process.umask(oldUmask) })

  it('existing 0600 destination: no group/other bit at the first write (durable)', () => {
    const f = join(root, 'editor.json')
    realFs.writeFileSync(f, '{"other":"token-A"}')
    realFs.chmodSync(f, 0o600)
    rec.on = true
    atomicWrite(f, '{"other":"token-A","kept":"token-B"}')
    rec.on = false
    const w = writes()
    expect(w.length).toBeGreaterThan(0)
    for (const e of w) expect(e.mode & 0o077).toBe(0)
    expect(modeOf(f)).toBe(0o600)
    expect(realFs.readFileSync(f, 'utf8')).toBe('{"other":"token-A","kept":"token-B"}')
  })

  it('existing 0600 destination: no group/other bit at the first write (durable: false)', () => {
    const f = join(root, 'cache.json')
    realFs.writeFileSync(f, 'x')
    realFs.chmodSync(f, 0o600)
    rec.on = true
    atomicWrite(f, 'secret', { durable: false })
    rec.on = false
    const w = writes()
    expect(w.length).toBeGreaterThan(0)
    for (const e of w) expect(e.mode & 0o077).toBe(0)
    expect(modeOf(f)).toBe(0o600)
  })

  it('new file at CONFIG_FILE_MODE: owner-only at the first write', () => {
    const f = join(root, 'config.yaml')
    rec.on = true
    atomicWrite(f, 'token: secret\n', { mode: CONFIG_FILE_MODE })
    rec.on = false
    const w = writes()
    expect(w.length).toBeGreaterThan(0)
    for (const e of w) expect(e.mode & 0o077).toBe(0)
    expect(modeOf(f)).toBe(0o600)
  })

  it('a 0644 destination still ends at 0644 (mode preserved, never widened mid-write)', () => {
    const f = join(root, 'engrams.yaml')
    realFs.writeFileSync(f, 'engrams: []\n')
    realFs.chmodSync(f, 0o644)
    rec.on = true
    atomicWrite(f, 'engrams: [1]\n')
    rec.on = false
    for (const e of writes()) expect(e.mode & ~0o644).toBe(0)
    expect(modeOf(f)).toBe(0o644)
  })

  it('a 0400 destination ends at 0400', () => {
    const f = join(root, 'ro.yaml')
    realFs.writeFileSync(f, 'a\n')
    realFs.chmodSync(f, 0o400)
    atomicWrite(f, 'b\n')
    expect(modeOf(f)).toBe(0o400)
    expect(realFs.readFileSync(f, 'utf8')).toBe('b\n')
  })

  it('never writes through a link planted at the temp name (exclusive create)', () => {
    const f = join(root, 'config.yaml')
    const victim = join(root, 'victim.txt')
    realFs.writeFileSync(victim, 'untouched')
    realFs.writeFileSync(f, 'old\n')
    realFs.chmodSync(f, 0o600)
    // Plant links at the next temp names this process would use.
    for (let i = 0; i < 64; i++) {
      try { realFs.symlinkSync(victim, `${f}.${process.pid}.${i}.tmp`) } catch { /* exists */ }
    }
    atomicWrite(f, 'new\n')
    expect(realFs.readFileSync(victim, 'utf8')).toBe('untouched')
    expect(realFs.lstatSync(f).isSymbolicLink()).toBe(false)
    expect(realFs.readFileSync(f, 'utf8')).toBe('new\n')
    expect(modeOf(f)).toBe(0o600)
  })
})

describe('atomicWrite on Windows: owner-only access list before the first content write', () => {
  let saved: typeof _atomicWriteAcl
  let calls: string[][]
  let readOutput: (p: string) => string

  beforeEach(() => {
    saved = { ..._atomicWriteAcl }
    calls = []
    readOutput = p => `${p} CORP\\alice:(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`
    _atomicWriteAcl.platform = 'win32'
    _atomicWriteAcl.env = { USERNAME: 'alice', USERDOMAIN: 'CORP' }
    _atomicWriteAcl.exec = (cmd, args) => {
      calls.push([cmd, ...args])
      rec.events.push({ kind: 'acl', args })
      if (args.length === 1) return { status: 0, stdout: readOutput(args[0]) }
      return { status: 0, stdout: '' }
    }
  })
  afterEach(() => { Object.assign(_atomicWriteAcl, saved) })

  it('credential mode over an owner-only destination: temp made owner-only (and verified) before any byte', () => {
    const f = join(root, 'config.yaml')
    realFs.writeFileSync(f, 'token: old\n')
    rec.on = true
    atomicWrite(f, 'token: secret\n', { mode: CONFIG_FILE_MODE })
    rec.on = false
    const firstWrite = rec.events.findIndex(e => e.kind === 'write')
    const set = rec.events.findIndex(e => e.kind === 'acl' && e.args.includes('/inheritance:r'))
    const verify = rec.events.findIndex((e, i) => i > set && e.kind === 'acl' && e.args.length === 1)
    expect(set).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(set)
    expect(firstWrite).toBeGreaterThan(verify)
    // The access list was set on the TEMP file, not the destination.
    const setArgs = (rec.events[set] as { args: string[] }).args
    expect(setArgs[0]).toMatch(/config\.yaml\.\d+\.\d+\.tmp$/)
    expect(setArgs).toContain('CORP\\alice:F')
    expect(realFs.readFileSync(f, 'utf8')).toBe('token: secret\n')
  })

  it('credential mode, new file: no icacls (new-file protection is the shared helper\'s job)', () => {
    const f = join(root, 'fresh.yaml')
    atomicWrite(f, 'token: secret\n', { mode: CONFIG_FILE_MODE })
    expect(calls).toEqual([])
    expect(realFs.readFileSync(f, 'utf8')).toBe('token: secret\n')
  })

  // Codex round 3, finding 1. This case used to pin the fail-open behaviour
  // (icacls failed → write anyway, unprotected). "Could not inspect" is not
  // "not protected": a credential write over an existing destination whose
  // access list cannot be read must refuse, not risk replacing an owner-only
  // file with one the folder's other accounts can read.
  const expectRefusedUntouched = (f: string, run: () => void) => {
    rec.on = true
    expect(run).toThrow(/cannot (inspect|tell)/)
    rec.on = false
    expect(rec.events.some(e => e.kind === 'write')).toBe(false)
    expect(realFs.readFileSync(f, 'utf8')).toBe('a\n')
    expect(realFs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
    expect(calls.some(c => c.includes('/inheritance:r'))).toBe(false)
  }

  it('icacls fails, owner-only mode WITHOUT secret: written, not refused (only secret writes fail closed)', () => {
    // Known residual, reported: config.yaml and folder-map writers pass only
    // an owner-only mode and have not opted in to failing closed.
    const f = join(root, 'folders.yaml')
    realFs.writeFileSync(f, 'a\n')
    _atomicWriteAcl.exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: null, stdout: '' } }
    atomicWrite(f, 'b\n', { mode: 0o600 })
    expect(realFs.readFileSync(f, 'utf8')).toBe('b\n')
    expect(calls.some(c => c.includes('/inheritance:r'))).toBe(false)
  })

  it('icacls fails on the destination (secret + owner-only mode): refuses, destination unchanged', () => {
    const f = join(root, 'config.yaml')
    realFs.writeFileSync(f, 'a\n')
    _atomicWriteAcl.exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: null, stdout: '' } }
    expectRefusedUntouched(f, () => atomicWrite(f, 'b\n', { mode: 0o600, secret: true }))
  })

  it('Windows account unknown, owner-only mode without secret: written', () => {
    const f = join(root, 'folders.yaml')
    realFs.writeFileSync(f, 'a\n')
    _atomicWriteAcl.env = {}
    atomicWrite(f, 'b\n', { mode: 0o600 })
    expect(realFs.readFileSync(f, 'utf8')).toBe('b\n')
  })

  it('icacls fails on the destination (secret): refuses, destination unchanged', () => {
    const f = join(root, 'editor.json')
    realFs.writeFileSync(f, 'a\n')
    _atomicWriteAcl.exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: 5, stdout: '' } }
    expectRefusedUntouched(f, () => atomicWrite(f, 'b\n', { secret: true }))
  })

  it('icacls output names no account (unparseable): refuses', () => {
    const f = join(root, 'editor.json')
    realFs.writeFileSync(f, 'a\n')
    readOutput = () => 'Successfully processed 1 files; Failed processing 0 files\n'
    expectRefusedUntouched(f, () => atomicWrite(f, 'b\n', { secret: true }))
  })

  it('Windows account unknown (USERNAME unset): refuses a secret write over an existing file', () => {
    const f = join(root, 'editor.json')
    realFs.writeFileSync(f, 'a\n')
    _atomicWriteAcl.env = {}
    expectRefusedUntouched(f, () => atomicWrite(f, 'b\n', { secret: true }))
  })

  it('ordinary write over an existing file with icacls failing: still never calls icacls, writes', () => {
    const f = join(root, 'engrams.yaml')
    realFs.writeFileSync(f, 'a\n')
    _atomicWriteAcl.exec = (cmd, args) => { calls.push([cmd, ...args]); return { status: null, stdout: '' } }
    _atomicWriteAcl.env = {}
    atomicWrite(f, 'b\n')
    expect(calls).toEqual([])
    expect(realFs.readFileSync(f, 'utf8')).toBe('b\n')
  })

  it('secret write over a protected destination: protects the temp file before any byte', () => {
    const f = join(root, 'editor.json')
    realFs.writeFileSync(f, '{"a":1}')
    rec.on = true
    atomicWrite(f, '{"a":2}', { secret: true })
    rec.on = false
    const firstWrite = rec.events.findIndex(e => e.kind === 'write')
    const set = rec.events.findIndex(e => e.kind === 'acl' && e.args.includes('/inheritance:r'))
    expect(set).toBeGreaterThanOrEqual(0)
    expect(firstWrite).toBeGreaterThan(set)
    expect((rec.events[set] as { args: string[] }).args[0]).toMatch(/\.tmp$/)
  })

  it('secret write over a destination others can read: access list left alone', () => {
    const f = join(root, 'editor.json')
    realFs.writeFileSync(f, '{"a":1}')
    readOutput = p => `${p} CORP\\alice:(F)\n BUILTIN\\Users:(RX)\n`
    atomicWrite(f, '{"a":2}', { secret: true })
    expect(calls.some(c => c.includes('/inheritance:r'))).toBe(false)
    expect(realFs.readFileSync(f, 'utf8')).toBe('{"a":2}')
  })

  it('protection that cannot be verified: refuses, writes nothing, destination unchanged', () => {
    const f = join(root, 'config.yaml')
    realFs.writeFileSync(f, 'token: old\n')
    // The destination reads as owner-only; the temp file's list does not take.
    readOutput = p => p.endsWith('.tmp') ? `${p} CORP\\alice:(F)\n Everyone:(R)\n` : `${p} CORP\\alice:(F)\n`
    rec.on = true
    expect(() => atomicWrite(f, 'token: new\n', { mode: CONFIG_FILE_MODE })).toThrow(/owner-only/)
    rec.on = false
    expect(rec.events.some(e => e.kind === 'write')).toBe(false)
    expect(realFs.readFileSync(f, 'utf8')).toBe('token: old\n')
    expect(realFs.readdirSync(root).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('ordinary writes never call icacls', () => {
    const f = join(root, 'engrams.yaml')
    atomicWrite(f, 'engrams: []\n')
    atomicWrite(f, 'engrams: [1]\n')
    expect(calls).toEqual([])
  })
})
