import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'fs'
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

  it('bare "plur trust" with no argument trusts the CURRENT directory', () => {
    const out = execSync(`node ${CLI} trust --path ${plurHome} --json`, {
      encoding: 'utf-8', timeout: 10000, cwd: target,
    }).trim()
    const parsed = JSON.parse(out)
    expect(parsed.trusted).toBe(target)
  })
})
