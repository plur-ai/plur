import { X509Certificate, createHash } from 'crypto'
import { chmodSync, readFileSync } from 'fs'
import { join } from 'path'
import * as tls from 'tls'
import { atomicWrite } from '@plur-ai/core'
import type { ExecFn } from './exec.js'

/**
 * The company CA, accepted only by its pinned fingerprint (#1638).
 *
 * Trust rules, all enforced here and modelled in spec/formal/PlurSpec/Trust.lean:
 * - The ONLY trust decision is "SHA-256 of this certificate's DER equals the
 *   pinned value". Where a candidate came from (a file the install script
 *   handed over, a system store) never makes it trusted; every source is just
 *   text to search.
 * - Exactly one certificate — the matching one, re-encoded from its DER — is
 *   written to `<plurDir>/company-ca.pem`. A bundle that holds the CA next to
 *   other certificates never brings those others along.
 * - The file is used through NODE_EXTRA_CA_CERTS (launch-env.ts), which ADDS
 *   to Node's default roots. Nothing here replaces the default trust or turns
 *   TLS verification off.
 * - A refusal (invalid fingerprint, not found, mismatch) writes nothing.
 */

export const COMPANY_CA_FILE = 'company-ca.pem'
const CA_FILE_MODE = 0o600

/** The served installer's rule for INSTALL_CA_SHA256: 64 lower-case hex, no colons. */
const CA_SHA256_RE = /^[0-9a-f]{64}$/

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

/** Lower-case hex SHA-256 of the certificate's DER (`openssl x509 -outform DER | sha256sum`). */
export function caSha256(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
}

/** Every `BEGIN/END CERTIFICATE` block in `text`, in order. Anything between blocks is ignored. */
export function splitPemBundle(text: string): string[] {
  return text.match(PEM_BLOCK) ?? []
}

export type CaSourceDeps = {
  /** Node's own copy of the OS store (`tls.getCACertificates('system')`, Node 22.15+/23.10+). */
  systemCertificates?: () => string[]
  readFile?: (path: string) => string
  /** Only SystemRoot is read (win32). Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

const LINUX_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
]

const DARWIN_KEYCHAINS = [
  '/Library/Keychains/System.keychain',
  '/System/Library/Keychains/SystemRootCertificates.keychain',
]

/**
 * PowerShell, one line so `-Command -` runs it whole: each certificate in the
 * machine and user root stores and the machine intermediate store, as PEM.
 *
 * Plain .NET only — no cmdlet, no `Cert:` drive, no `$env:` — so nothing a
 * module path (PSModulePath), a profile or an environment variable can shadow
 * or feed decides what runs. The script is a constant; nothing is spliced in.
 */
const WIN32_EXPORT_SCRIPT =
  "$ErrorActionPreference = 'Continue'; " +
  "foreach ($p in @('Root/LocalMachine', 'Root/CurrentUser', 'CA/LocalMachine')) { " +
  "try { $n, $l = $p.Split('/'); " +
  '$st = [System.Security.Cryptography.X509Certificates.X509Store]::new($n, [System.Security.Cryptography.X509Certificates.StoreLocation]$l); ' +
  "$st.Open([System.Security.Cryptography.X509Certificates.OpenFlags]'ReadOnly, OpenExistingOnly'); " +
  'foreach ($c in $st.Certificates) { ' +
  '[Console]::Out.Write("-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($c.RawData, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n") }; ' +
  '$st.Close() } catch { } }\n'

const WIN32_POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']

/** A Windows folder we accept from SystemRoot: a plain `X:\\…` path with no `..`, quotes or separators. */
const WIN_DRIVE_PATH = /^[A-Za-z]:\\[A-Za-z0-9 _().\\-]*$/

/**
 * Windows PowerShell 5.1 by absolute path. Never the bare name: Windows
 * process creation looks in the current folder before PATH, so a
 * `powershell.exe` planted in whatever folder `init` runs from would run
 * instead. SystemRoot is used only when it is a plain drive path.
 */
export function win32PowerShellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot
  const ok = typeof root === 'string' && WIN_DRIVE_PATH.test(root) && !root.split('\\').includes('..')
  const base = (ok ? root : 'C:\\Windows').replace(/\\+$/, '')
  return `${base}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** macOS `security`, by absolute path (never looked up on PATH). */
const DARWIN_SECURITY = '/usr/bin/security'

const STORE_TIMEOUT_MS = 30_000

function defaultSystemCertificates(): string[] {
  const get = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates
  return typeof get === 'function' ? get('system') : []
}

/**
 * The texts to search for the company CA, in order: Node's own system store
 * when it has one, then the platform's store. A source that fails is skipped:
 * the fingerprint check decides, so a missing source can only mean "not found".
 */
export function systemCaSources(platform: NodeJS.Platform, exec: ExecFn, deps: CaSourceDeps = {}): string[] {
  const sources: string[] = []
  const attempt = (fn: () => string | string[]) => {
    try {
      const out = fn()
      for (const s of Array.isArray(out) ? out : [out]) if (s) sources.push(s)
    } catch {
      // skipped — see above
    }
  }
  attempt(() => (deps.systemCertificates ?? defaultSystemCertificates)().join('\n'))
  if (platform === 'linux') {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
    for (const p of LINUX_BUNDLES) attempt(() => read(p))
  } else if (platform === 'darwin') {
    attempt(() => exec(DARWIN_SECURITY, ['find-certificate', '-a', '-p', ...DARWIN_KEYCHAINS], { timeoutMs: STORE_TIMEOUT_MS }).stdout)
  } else if (platform === 'win32') {
    attempt(() => exec(win32PowerShellPath(deps.env ?? process.env), WIN32_POWERSHELL_ARGS, { input: WIN32_EXPORT_SCRIPT, timeoutMs: STORE_TIMEOUT_MS }).stdout)
  }
  return sources
}

/**
 * The one certificate whose DER hashes to `sha256`, re-encoded on its own, or
 * null. A fingerprint that breaks the served-installer rule matches nothing.
 */
export function findCompanyCa(sha256: string, sources: string[]): { pem: string; subject: string } | null {
  if (!CA_SHA256_RE.test(sha256)) return null
  for (const source of sources) {
    for (const block of splitPemBundle(source)) {
      let cert: X509Certificate
      try {
        cert = new X509Certificate(block)
      } catch {
        continue
      }
      if (createHash('sha256').update(cert.raw).digest('hex') === sha256) {
        return { pem: cert.toString(), subject: cert.subject }
      }
    }
  }
  return null
}

export type InstallCaResult =
  | { ok: true; path: string; subject: string }
  | { ok: false; reason: 'not-found' | 'mismatch' | 'invalid-fingerprint' }

/**
 * Find the pinned CA and write it alone to `<plurDir>/company-ca.pem`.
 *
 * A `caFile` (handed over by the install script) is checked again, never
 * trusted: if it holds no certificate with the pinned fingerprint the result is
 * `mismatch` and the system stores are NOT searched — the script said where the
 * CA is, and a different answer elsewhere is not what it found.
 */
export function installCompanyCa(opts: {
  sha256: string
  caFile?: string
  plurDir: string
  platform: NodeJS.Platform
  exec: ExecFn
  systemCertificates?: () => string[]
  readFile?: (path: string) => string
  env?: NodeJS.ProcessEnv
}): InstallCaResult {
  if (!CA_SHA256_RE.test(opts.sha256)) return { ok: false, reason: 'invalid-fingerprint' }
  let found: { pem: string; subject: string } | null
  if (opts.caFile !== undefined) {
    let text: string
    try {
      text = (opts.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(opts.caFile)
    } catch {
      return { ok: false, reason: 'not-found' }
    }
    found = findCompanyCa(opts.sha256, [text])
    if (!found) return { ok: false, reason: 'mismatch' }
  } else {
    found = findCompanyCa(opts.sha256, systemCaSources(opts.platform, opts.exec, {
      systemCertificates: opts.systemCertificates,
      readFile: opts.readFile,
      env: opts.env,
    }))
    if (!found) return { ok: false, reason: 'not-found' }
  }
  const path = join(opts.plurDir, COMPANY_CA_FILE)
  // Atomic, so a reader never sees a half-written file. Owner-only: the
  // certificate is public, but only this account may read or replace the file
  // every PLUR launch adds to its trust. atomicWrite keeps an existing file's
  // mode, so a wider earlier copy is tightened explicitly.
  atomicWrite(path, found.pem.endsWith('\n') ? found.pem : `${found.pem}\n`, { mode: CA_FILE_MODE })
  if (process.platform !== 'win32') chmodSync(path, CA_FILE_MODE)
  return { ok: true, path, subject: found.subject }
}
