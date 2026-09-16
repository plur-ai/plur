import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * `plur trust` / `plur untrust` (D2, 2026-09 audit) — the directory-trust
 * grant an adapter (opencode's `resolveTrustedScope`) checks before adopting
 * a `.plur.yaml` scope/domain it finds on disk. See
 * `packages/core/src/trust.ts` for the model.
 */
describe('plur trust / untrust (D2)', () => {
  let plurHome: string
  let target: string

  beforeEach(() => {
    plurHome = mkdtempSync(join(tmpdir(), 'plur-trust-cli-home-'))
    target = realpathSync(mkdtempSync(join(tmpdir(), 'plur-trust-cli-target-')))
  })

  afterEach(() => {
    rmSync(plurHome, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  })

  const run = (args: string) =>
    execSync(`node ${CLI} ${args} --path ${plurHome} --json`, { encoding: 'utf-8', timeout: 10000 }).trim()

  it('trust --list is empty with nothing trusted', () => {
    const out = JSON.parse(run('trust --list'))
    expect(out.trusted).toEqual([])
    expect(out.count).toBe(0)
  })

  it('trust <dir> grants trust; trust --list then shows it', () => {
    const t = JSON.parse(run(`trust ${target}`))
    expect(t.success).toBe(true)
    expect(t.trusted).toBe(target)

    const list = JSON.parse(run('trust --list'))
    expect(list.trusted).toContain(target)
    expect(list.count).toBe(1)
  })

  it('trust is idempotent', () => {
    run(`trust ${target}`)
    run(`trust ${target}`)
    const list = JSON.parse(run('trust --list'))
    expect(list.count).toBe(1)
  })

  it('untrust <dir> revokes a grant and reports removed:true; untrusting again reports removed:false', () => {
    run(`trust ${target}`)
    const u1 = JSON.parse(run(`untrust ${target}`))
    expect(u1.success).toBe(true)
    expect(u1.removed).toBe(true)

    const list = JSON.parse(run('trust --list'))
    expect(list.trusted).not.toContain(target)

    const u2 = JSON.parse(run(`untrust ${target}`))
    expect(u2.removed).toBe(false)
  })

  // E7 (2026-09 audit, minor): `plur trust` used to print only `Trusted:
  // <path>`, never showing what a `.plur.yaml` at that path actually
  // authorizes — the one moment a human is in the loop, and they were shown
  // nothing.
  describe('trust discloses what a .plur.yaml at the target authorizes (E7)', () => {
    it('prints scope/domain/remote_url when the directory has a .plur.yaml', () => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(
        join(target, '.plur.yaml'),
        'scope: group:acme/eng\ndomain: acme.engineering\nremote_url: https://plur.acme.example.com\n',
      )
      const out = JSON.parse(run(`trust ${target}`))
      expect(out.scope).toBe('group:acme/eng')
      expect(out.domain).toBe('acme.engineering')
      expect(out.remote_url).toBe('https://plur.acme.example.com')
      expect(out.config_path).toBe(join(target, '.plur.yaml'))
    })

    it('omits scope/domain/remote_url when no .plur.yaml declares any', () => {
      const out = JSON.parse(run(`trust ${target}`))
      expect(out).not.toHaveProperty('scope')
      expect(out).not.toHaveProperty('domain')
      expect(out).not.toHaveProperty('remote_url')
    })
  })

  it('bare "plur trust" with no argument trusts the CURRENT directory', () => {
    const out = execSync(`node ${CLI} trust --path ${plurHome} --json`, {
      encoding: 'utf-8', timeout: 10000, cwd: target,
    }).trim()
    const parsed = JSON.parse(out)
    expect(parsed.trusted).toBe(target)
  })

  // E3 (2026-09 audit): `plur untrust <subdir>` used to print "was not
  // trusted" for a subdirectory of a trusted repo — true of the exact-match
  // removal, false of the actual security question (it is still trusted,
  // via the ancestor).
  describe('untrust <subdir-of-a-trusted-repo> (E3)', () => {
    it('reports still_trusted + the covering ancestor instead of a bare false removal', () => {
      run(`trust ${target}`)
      const sub = join(target, 'packages', 'inner')
      mkdirSync(sub, { recursive: true })

      const out = JSON.parse(run(`untrust ${sub}`))
      expect(out.removed).toBe(false)
      expect(out.still_trusted).toBe(true)
      expect(out.covering_ancestor).toBe(target)

      // The ancestor grant is untouched — the subdirectory is still trusted.
      const list = JSON.parse(run('trust --list'))
      expect(list.trusted).toContain(target)
    })

    it('untrusting the named covering ancestor actually revokes coverage', () => {
      run(`trust ${target}`)
      const sub = join(target, 'packages', 'inner')
      mkdirSync(sub, { recursive: true })

      const first = JSON.parse(run(`untrust ${sub}`))
      const revoked = JSON.parse(run(`untrust ${first.covering_ancestor}`))
      expect(revoked.removed).toBe(true)

      const list = JSON.parse(run('trust --list'))
      expect(list.trusted).not.toContain(target)
    })

    it('reports still_trusted: false with no covering_ancestor when truly untrusted', () => {
      const out = JSON.parse(run(`untrust ${target}`))
      expect(out.removed).toBe(false)
      expect(out.still_trusted).toBe(false)
      expect(out).not.toHaveProperty('covering_ancestor')
    })
  })
})
