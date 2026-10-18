/**
 * The installer's key file protection (#1638, plan C Task 4; audit finding 2).
 *
 * `protectKeyFile` is a thin wrapper over core's `protectOwnerOnly` — one rule
 * for the installer and every later core write of config.yaml: Unix 0600, read
 * back; Windows an owner-only access list keyed by the account's SID (never
 * its name: icacls prints names in the OEM code page), read back as SDDL.
 * The Windows path runs here through a fake icacls/whoami; the real one runs
 * only in Windows CI (core's config-owner-only test).
 *
 * Refs plur-ai/plur#1638
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const core = vi.hoisted(() => ({ calls: [] as unknown[][], answer: null as null | { ok: boolean; detail?: string } }))
vi.mock('@plur-ai/core', async importOriginal => {
  const real = await importOriginal<typeof import('@plur-ai/core')>()
  return {
    ...real,
    protectOwnerOnly: (...args: Parameters<typeof real.protectOwnerOnly>) => {
      core.calls.push(args)
      return core.answer ?? real.protectOwnerOnly(...args)
    },
  }
})

const { protectKeyFile } = await import('../src/enterprise/key-file.js')

const isWin = process.platform === 'win32'
const ACCOUNT = 'ACME\\alice'
const SID = 'S-1-5-21-1111-2222-3333-1001'

let root: string
let file: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plur-key-file-'))
  file = join(root, 'config.yaml')
  writeFileSync(file, 'stores: []\n')
  core.calls = []
  core.answer = null
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe.skipIf(isWin)('Unix', () => {
  it('a 0644 key file is 0600 after protectKeyFile → { ok: true }', () => {
    chmodSync(file, 0o644)
    expect(protectKeyFile(file, 'linux', undefined, 'alice')).toEqual({ ok: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('a chmod that does nothing (fixed-mode mount) is reported, never passed: core\'s verdict is returned as is', () => {
    core.answer = { ok: false, detail: 'mode is 644, expected 600' }
    expect(protectKeyFile(file, 'linux', undefined, 'alice')).toEqual({ ok: false, detail: 'mode is 644, expected 600' })
  })
})

describe('delegation to core', () => {
  it('calls core protectOwnerOnly once with { platform, exec, account: user }', () => {
    const exec = () => ({ status: 0, stdout: '' })
    core.answer = { ok: true }
    protectKeyFile(file, 'win32', exec, ACCOUNT)
    expect(core.calls).toEqual([[file, { platform: 'win32', exec, account: ACCOUNT }]])
  })

  it('with no runner given, core\'s own (System32 by full path) is used: exec is not passed', () => {
    core.answer = { ok: true }
    protectKeyFile(file, 'win32', undefined, ACCOUNT)
    expect(core.calls).toHaveLength(1)
    expect(core.calls[0][1]).toEqual({ platform: 'win32', account: ACCOUNT })
    expect('exec' in (core.calls[0][1] as object)).toBe(false)
  })
})

describe('Windows (fake icacls and whoami)', () => {
  type Answer = { status: number | null; stdout: string }
  function fakeExec(answer: (args: string[]) => Answer) {
    const calls: string[][] = []
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return cmd === 'whoami' ? { status: 0, stdout: `"${ACCOUNT}","${SID}"\r\n` } : answer(args)
    }
    return { calls, exec }
  }
  /** What `icacls <path> /save <file>` writes (UTF-16LE SDDL) for these trustees. */
  const saved = (args: string[], trustees: string[]): Answer => {
    writeFileSync(args[2], Buffer.from(`config.yaml\r\nD:PAI${trustees.map(t => `(A;;FA;;;${t})`).join('')}\r\n`, 'utf16le'))
    return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\n' }
  }
  const done = { status: 0, stdout: 'processed file: x\nSuccessfully processed 1 files; Failed processing 0 files\n' }

  it('owner-only by SID: the grant names *<SID>, the list read back holds only the account → ok', () => {
    const { calls, exec } = fakeExec(args => (args[1] === '/save' ? saved(args, [SID]) : done))
    expect(protectKeyFile(file, 'win32', exec, ACCOUNT)).toEqual({ ok: true })
    const icacls = calls.filter(c => c[0] === 'icacls')
    expect(icacls[0]).toEqual(['icacls', file, '/inheritance:r', '/grant:r', `*${SID}:F`])
    expect(icacls.some(c => c[2] === '/save')).toBe(true)
    // Never matched by name: the account name is not passed to icacls.
    expect(calls.flat().some(a => a.includes('alice'))).toBe(false)
  })

  it('a list that still names BUILTIN\\Users after the removal → { ok:false, detail: "also readable by BUILTIN\\\\Users" }', () => {
    const { exec } = fakeExec(args => (args[1] === '/save' ? saved(args, [SID, 'BU']) : done))
    expect(protectKeyFile(file, 'win32', exec, ACCOUNT)).toEqual({ ok: false, detail: 'also readable by BUILTIN\\Users' })
  })

  it('icacls exit 5 → { ok:false, detail: /icacls failed/ }', () => {
    const { exec } = fakeExec(() => ({ status: 5, stdout: '' }))
    const r = protectKeyFile(file, 'win32', exec, ACCOUNT)
    expect(r.ok).toBe(false)
    expect((r as { detail: string }).detail).toMatch(/icacls failed/)
  })

  it('an unknown account (no USERNAME) is refused, never passed', () => {
    const { exec, calls } = fakeExec(() => done)
    expect(protectKeyFile(file, 'win32', exec, null).ok).toBe(false)
    expect(calls.filter(c => c[0] === 'icacls')).toEqual([])
  })
})
