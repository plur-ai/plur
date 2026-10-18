// Company CA by fingerprint (#1638). The CA is accepted only when the SHA-256 of
// its DER equals the pinned value; it is ADDED to Node's default trust through
// NODE_EXTRA_CA_CERTS (never replacing it), and nothing here disables TLS
// verification. The win32 source is tested through a fake exec on every OS.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, X509Certificate } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  caSha256,
  splitPemBundle,
  systemCaSources,
  findCompanyCa,
  installCompanyCa,
  COMPANY_CA_FILE,
  win32IcaclsExec,
} from '../src/enterprise/ca.js'
import type { ExecFn } from '../src/enterprise/exec.js'

const fixture = (name: string) => join(__dirname, 'fixtures', 'enterprise', name)
const pem = readFileSync(fixture('test-ca.pem'), 'utf8')
const otherPem = readFileSync(fixture('other-ca.pem'), 'utf8')
const sha = createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
const otherSha = createHash('sha256').update(new X509Certificate(otherPem).raw).digest('hex')

const noExec: ExecFn = () => ({ status: 1, stdout: '' })

// A fake icacls: `set` succeeds, and the read-back names `principals`.
const fakeIcacls = (principals: string[], calls: string[][] = []) => (cmd: string, args: string[]) => {
  calls.push([cmd, ...args])
  if (args.length > 1) return { status: 0, stdout: 'processed file: x\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n' }
  return { status: 0, stdout: `${args[0]} ${principals.map(p => `${p}:(F)`).join('\r\n ')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n` }
}
const winOk = { env: { SystemRoot: 'C:\\Windows' }, account: 'ACME\\alice', aclExec: fakeIcacls(['ACME\\alice']) }

describe('caSha256', () => {
  it('is the lower-case hex SHA-256 of the DER, the format the served installer bakes (64 hex, no colons)', () => {
    expect(caSha256(pem)).toBe(sha)
    expect(caSha256(pem)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('splitPemBundle', () => {
  it('splits a bundle into its certificates, CRLF included', () => {
    const bundle = `# comment\n${otherPem}\n${pem.replace(/\n/g, '\r\n')}`
    const parts = splitPemBundle(bundle)
    expect(parts).toHaveLength(2)
    expect(caSha256(parts[0])).toBe(otherSha)
    expect(caSha256(parts[1])).toBe(sha)
  })

  it('an unterminated BEGIN does not swallow the next certificate', () => {
    const text = `-----BEGIN CERTIFICATE-----\ngarbage\n${pem}`
    expect(splitPemBundle(text).map(caSha256)).toEqual([sha])
    expect(findCompanyCa(sha, [text])).not.toBeNull()
  })

  it('many unterminated BEGIN markers are scanned in linear time', () => {
    const text = '-----BEGIN CERTIFICATE-----\nx\n'.repeat(200_000) + pem
    const t0 = Date.now()
    expect(splitPemBundle(text).map(caSha256)).toEqual([sha])
    expect(splitPemBundle('-----BEGIN CERTIFICATE-----\n'.repeat(200_000))).toEqual([])
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('returns nothing for text with no certificate', () => {
    expect(splitPemBundle('no certificates here')).toEqual([])
  })
})

describe('findCompanyCa', () => {
  it('finds the pinned CA inside a bundle', () => {
    expect(findCompanyCa(sha, [otherPem + pem])?.subject).toContain('Example Test Root CA')
  })

  it('returns null when no certificate matches the fingerprint', () => {
    expect(findCompanyCa(sha, [otherPem])).toBeNull()
  })

  it('returns only the matching certificate, never the rest of the bundle', () => {
    const found = findCompanyCa(sha, [otherPem + pem])
    expect(found).not.toBeNull()
    expect(splitPemBundle(found!.pem)).toHaveLength(1)
    expect(caSha256(found!.pem)).toBe(sha)
  })

  it('skips a broken certificate block and keeps looking', () => {
    const broken = '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n'
    expect(findCompanyCa(sha, [broken + pem])?.subject).toContain('Example Test Root CA')
  })

  it('a fingerprint that is not 64 lower-case hex matches nothing', () => {
    expect(findCompanyCa(sha.toUpperCase(), [pem])).toBeNull()
    expect(findCompanyCa(sha.replace(/(..)/g, '$1:').slice(0, -1), [pem])).toBeNull()
  })
})

describe('systemCaSources', () => {
  it('win32: runs the System32 powershell.exe by absolute path, script on stdin, Root and CA stores', () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string; timeoutMs?: number }> = []
    const exec: ExecFn = (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input, timeoutMs: opts?.timeoutMs })
      return { status: 0, stdout: pem }
    }
    const sources = systemCaSources('win32', exec, { systemCertificates: () => [], env: { SystemRoot: 'D:\\Windows' } })
    expect(calls).toHaveLength(1)
    // Never a bare name: Windows process creation looks in the current folder
    // before PATH, so a powershell.exe planted there would run instead.
    expect(calls[0].cmd).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0].args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'])
    for (const store of ["'Root/LocalMachine'", "'Root/CurrentUser'", "'CA/LocalMachine'"]) expect(calls[0].input).toContain(store)
    // Plain .NET, no cmdlet: nothing the module path (PSModulePath) or a profile can shadow,
    // and nothing taken from the environment.
    expect(calls[0].input).toContain('System.Security.Cryptography.X509Certificates.X509Store')
    expect(calls[0].input).not.toMatch(/Get-ChildItem|ForEach-Object|Cert:|\$env:|Import-Module/i)
    expect(calls[0].timeoutMs).toBeGreaterThan(0)
    // One line, so `-Command -` runs it whole.
    expect(calls[0].input!.trim().split('\n')).toHaveLength(1)
    expect(findCompanyCa(sha, sources)?.subject).toContain('Example Test Root CA')
  })

  it('win32: a SystemRoot that is not <drive>:\\Windows runs nothing (fail closed: the CA is then not found)', () => {
    for (const SystemRoot of [undefined, '', '.', 'Windows', 'C:\\Users\\Public\\evil', '\\\\evil\\share\\Windows', 'C:\\Windows\\..\\Users\\x', 'C:\\Win"dows', 'C:\\Windows\n', 'C:\\a;b']) {
      const calls: string[] = []
      const sources = systemCaSources('win32', (cmd) => { calls.push(cmd); return { status: 0, stdout: pem } }, { systemCertificates: () => [], env: { SystemRoot } })
      expect(calls).toEqual([])
      expect(sources).toEqual([])
    }
    const calls: string[] = []
    systemCaSources('win32', (cmd) => { calls.push(cmd); return { status: 0, stdout: '' } }, { systemCertificates: () => [], env: { SystemRoot: 'c:\\WINDOWS' } })
    expect(calls).toEqual(['c:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
  })

  it('darwin: reads the System keychain and the system roots through /usr/bin/security (absolute, never PATH)', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: ExecFn = (cmd, args) => {
      calls.push({ cmd, args })
      return { status: 0, stdout: pem }
    }
    const sources = systemCaSources('darwin', exec, { systemCertificates: () => [] })
    expect(calls).toEqual([
      {
        cmd: '/usr/bin/security',
        args: [
          'find-certificate', '-a', '-p',
          '/Library/Keychains/System.keychain',
          '/System/Library/Keychains/SystemRootCertificates.keychain',
        ],
      },
    ])
    expect(findCompanyCa(sha, sources)).not.toBeNull()
  })

  it('linux: reads the distribution bundles that exist, and runs nothing', () => {
    const read: string[] = []
    const sources = systemCaSources('linux', noExec, {
      systemCertificates: () => [],
      readFile: (p: string) => {
        read.push(p)
        if (p === '/etc/pki/tls/certs/ca-bundle.crt') return otherPem + pem
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(read).toEqual([
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ssl/ca-bundle.pem',
    ])
    expect(findCompanyCa(sha, sources)).not.toBeNull()
  })

  it("puts Node's own system store first when it has one", () => {
    const sources = systemCaSources('linux', noExec, { systemCertificates: () => [pem], readFile: () => '' })
    expect(sources[0]).toContain('BEGIN CERTIFICATE')
  })

  it('a failing source is skipped, never fatal', () => {
    const exec: ExecFn = () => { throw new Error('boom') }
    expect(systemCaSources('darwin', exec, { systemCertificates: () => { throw new Error('no') } })).toEqual([])
  })
})

describe('installCompanyCa', () => {
  let plurDir: string
  beforeEach(() => { plurDir = mkdtempSync(join(tmpdir(), 'plur-ca-')) })
  afterEach(() => { rmSync(plurDir, { recursive: true, force: true }) })

  it('a caFile from the script is checked again: a matching file is installed', () => {
    const caFile = join(plurDir, 'from-script.pem')
    writeFileSync(caFile, pem)
    const r = installCompanyCa({ sha256: sha, caFile, plurDir, platform: 'linux', exec: noExec })
    expect(r).toEqual({ ok: true, path: join(plurDir, COMPANY_CA_FILE), subject: expect.stringContaining('Example Test Root CA') })
    const written = readFileSync(join(plurDir, COMPANY_CA_FILE), 'utf8')
    expect(splitPemBundle(written).map(caSha256)).toEqual([sha])
  })

  it('caFile mismatch: refused, nothing written to plurDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-ca-src-'))
    try {
      const caFile = join(dir, 'other.pem')
      writeFileSync(caFile, otherPem)
      const r = installCompanyCa({ sha256: sha, caFile, plurDir, platform: 'linux', exec: noExec })
      expect(r).toEqual({ ok: false, reason: 'mismatch' })
      expect(readdirSync(plurDir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caFile mismatch does not fall back to the system stores (the script named a file)', () => {
    const caFile = join(plurDir, 'other.pem')
    writeFileSync(caFile, otherPem)
    const exec: ExecFn = () => ({ status: 0, stdout: pem })
    const r = installCompanyCa({ sha256: sha, caFile, plurDir, platform: 'darwin', exec })
    expect(r).toEqual({ ok: false, reason: 'mismatch' })
    expect(existsSync(join(plurDir, COMPANY_CA_FILE))).toBe(false)
  })

  it('a bundle caFile installs ONLY the pinned certificate (trust grows by exactly that CA)', () => {
    const caFile = join(plurDir, 'bundle.pem')
    writeFileSync(caFile, otherPem + pem)
    const r = installCompanyCa({ sha256: sha, caFile, plurDir, platform: 'linux', exec: noExec })
    expect(r.ok).toBe(true)
    const written = readFileSync(join(plurDir, COMPANY_CA_FILE), 'utf8')
    expect(splitPemBundle(written).map(caSha256)).toEqual([sha])
    expect(written).not.toContain(otherPem.trim().split('\n')[1])
  })

  it('a caFile that cannot be read is not-found, nothing written', () => {
    const r = installCompanyCa({ sha256: sha, caFile: join(plurDir, 'missing.pem'), plurDir, platform: 'linux', exec: noExec })
    expect(r).toEqual({ ok: false, reason: 'not-found' })
    expect(readdirSync(plurDir)).toEqual([])
  })

  it('not found: no source holds the CA → refused, nothing written', () => {
    const r = installCompanyCa({ sha256: sha, plurDir, platform: 'win32', exec: () => ({ status: 0, stdout: otherPem }), systemCertificates: () => [], ...winOk })
    expect(r).toEqual({ ok: false, reason: 'not-found' })
    expect(readdirSync(plurDir)).toEqual([])
  })

  it('found in the system store (win32 through a fake exec) → installed', () => {
    const r = installCompanyCa({ sha256: sha, plurDir, platform: 'win32', exec: () => ({ status: 0, stdout: otherPem + pem }), systemCertificates: () => [], ...winOk })
    expect(r.ok).toBe(true)
    expect(splitPemBundle(readFileSync(join(plurDir, COMPANY_CA_FILE), 'utf8')).map(caSha256)).toEqual([sha])
  })

  it('a fingerprint that breaks the served-installer rule is refused before anything is read', () => {
    let ran = false
    const exec: ExecFn = () => { ran = true; return { status: 0, stdout: pem } }
    for (const bad of [sha.toUpperCase(), sha.slice(0, 63), `${sha}0`, sha.replace(/(..)/g, '$1:').slice(0, -1), '']) {
      expect(installCompanyCa({ sha256: bad, plurDir, platform: 'darwin', exec })).toEqual({ ok: false, reason: 'invalid-fingerprint' })
    }
    expect(ran).toBe(false)
    expect(readdirSync(plurDir)).toEqual([])
  })

  it('a re-run replaces an earlier company-ca.pem with the pinned CA only', () => {
    writeFileSync(join(plurDir, COMPANY_CA_FILE), otherPem)
    const r = installCompanyCa({ sha256: sha, plurDir, platform: 'darwin', exec: () => ({ status: 0, stdout: pem }), systemCertificates: () => [] })
    expect(r.ok).toBe(true)
    expect(splitPemBundle(readFileSync(join(plurDir, COMPANY_CA_FILE), 'utf8')).map(caSha256)).toEqual([sha])
  })

  it.skipIf(process.platform === 'win32')('the written file is owner-only (0600), also when an earlier copy was wider', () => {
    const exec: ExecFn = () => ({ status: 0, stdout: pem })
    const first = installCompanyCa({ sha256: sha, plurDir, platform: 'darwin', exec, systemCertificates: () => [] })
    expect(first.ok).toBe(true)
    expect(statSync(join(plurDir, COMPANY_CA_FILE)).mode & 0o777).toBe(0o600)
    chmodSync(join(plurDir, COMPANY_CA_FILE), 0o666)
    installCompanyCa({ sha256: sha, plurDir, platform: 'darwin', exec, systemCertificates: () => [] })
    expect(statSync(join(plurDir, COMPANY_CA_FILE)).mode & 0o777).toBe(0o600)
  })

  it('win32: the file is made owner-only (icacls) BEFORE it is filled and put in place', () => {
    const calls: string[][] = []
    let contentAtProtect: string | null = null
    const aclExec = (cmd: string, args: string[]) => {
      if (args.length > 1) {
        contentAtProtect = readFileSync(args[0], 'utf8')
        expect(existsSync(join(plurDir, COMPANY_CA_FILE))).toBe(false)
      }
      return fakeIcacls(['ACME\\alice'], calls)(cmd, args)
    }
    const r = installCompanyCa({ sha256: sha, plurDir, platform: 'win32', exec: () => ({ status: 0, stdout: pem }), systemCertificates: () => [], env: { SystemRoot: 'C:\\Windows' }, account: 'ACME\\alice', aclExec })
    expect(r.ok).toBe(true)
    expect(contentAtProtect).toBe('')
    expect(calls[0]).toEqual(['icacls', expect.stringContaining(COMPANY_CA_FILE), '/inheritance:r', '/grant:r', 'ACME\\alice:F'])
    expect(readdirSync(plurDir)).toEqual([COMPANY_CA_FILE])
  })

  it('win32: icacls runs from System32 by absolute path, never by bare name', () => {
    const runs: string[][] = []
    const run = (cmd: string, args: string[]) => { runs.push([cmd, ...args]); return { status: 0, stdout: '' } }
    const icacls = win32IcaclsExec({ SystemRoot: 'D:\\Windows' }, run)!
    icacls('icacls', ['x', '/inheritance:r'])
    expect(runs).toEqual([['D:\\Windows\\System32\\icacls.exe', 'x', '/inheritance:r']])
    expect(win32IcaclsExec({ SystemRoot: 'C:\\Users\\Public\\evil' }, run)).toBeNull()
    expect(win32IcaclsExec({}, run)).toBeNull()
  })

  it('win32: with no trustworthy SystemRoot for icacls, nothing is written (refused)', () => {
    const r = installCompanyCa({ sha256: sha, caFile: join(plurDir, 'ca.pem'), plurDir, platform: 'win32', exec: noExec, readFile: () => pem, env: { SystemRoot: 'C:\\Users\\Public\\evil' }, account: 'ACME\\alice' })
    expect(r).toEqual({ ok: false, reason: 'unprotected' })
    expect(readdirSync(plurDir)).toEqual([])
  })

  it('win32: when owner-only cannot be established, nothing is written (refused)', () => {
    for (const opts of [
      { account: 'ACME\\alice', aclExec: fakeIcacls(['ACME\\alice', 'BUILTIN\\Users']) },
      { account: null, aclExec: fakeIcacls(['ACME\\alice']) },
      { account: 'ACME\\alice', aclExec: () => ({ status: 5, stdout: '' }) },
    ]) {
      const r = installCompanyCa({ sha256: sha, plurDir, platform: 'win32', exec: () => ({ status: 0, stdout: pem }), systemCertificates: () => [], env: { SystemRoot: 'C:\\Windows' }, ...opts })
      expect(r).toEqual({ ok: false, reason: 'unprotected' })
      expect(readdirSync(plurDir)).toEqual([])
    }
  })

  it.skipIf(process.platform === 'win32')('a wider earlier copy is replaced by a new file (new inode) at 0600, no temp file left', () => {
    writeFileSync(join(plurDir, COMPANY_CA_FILE), otherPem)
    chmodSync(join(plurDir, COMPANY_CA_FILE), 0o666)
    const before = statSync(join(plurDir, COMPANY_CA_FILE)).ino
    installCompanyCa({ sha256: sha, plurDir, platform: 'darwin', exec: () => ({ status: 0, stdout: pem }), systemCertificates: () => [] })
    const st = statSync(join(plurDir, COMPANY_CA_FILE))
    expect(st.ino).not.toBe(before)
    expect(st.mode & 0o777).toBe(0o600)
    expect(readdirSync(plurDir)).toEqual([COMPANY_CA_FILE])
  })

  it('a refused re-run removes nothing it did not write (an earlier file stays as it was)', () => {
    writeFileSync(join(plurDir, COMPANY_CA_FILE), pem)
    const r = installCompanyCa({ sha256: otherSha, plurDir, platform: 'darwin', exec: () => ({ status: 0, stdout: pem }), systemCertificates: () => [] })
    expect(r).toEqual({ ok: false, reason: 'not-found' })
    expect(readFileSync(join(plurDir, COMPANY_CA_FILE), 'utf8')).toBe(pem)
  })
})
