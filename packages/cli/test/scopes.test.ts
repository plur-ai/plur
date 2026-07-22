import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * `plur scopes` (#647) — the user-facing surface. The register/list-with-remote
 * paths are covered by core's offerableScopes/registerScope tests (they need a
 * stub /me); here we exercise the command wiring that needs no network:
 * empty-list, dismiss/reoffer persistence, and error handling.
 */
describe('plur scopes (#647)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-scopes-cli-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const run = (args: string) =>
    execSync(`node ${CLI} ${args} --path ${dir} --json`, { encoding: 'utf-8', timeout: 10000 }).trim()
  const rawConfig = () => readFileSync(join(dir, 'config.yaml'), 'utf8')

  it('list with no remote stores → empty and successful', () => {
    const out = JSON.parse(run('scopes'))
    expect(out.success).toBe(true)
    expect(out.action).toBe('list')
    expect(out.scopes).toEqual([])
  })

  it('dismiss persists to config; --reoffer clears it', () => {
    const d = JSON.parse(run('scopes dismiss group:acme/team'))
    expect(d.success).toBe(true)
    expect(d.action).toBe('dismiss')
    expect(rawConfig()).toContain('group:acme/team') // written under dismissed_scopes

    const r = JSON.parse(run('scopes --reoffer'))
    expect(r.success).toBe(true)
    expect(r.cleared).toContain('group:acme/team')
    expect(rawConfig()).not.toContain('group:acme/team') // dismissal cleared
  })

  it('register a scope no configured remote authorizes → reports failure', () => {
    const out = JSON.parse(run('scopes register group:acme/nope'))
    expect(out.success).toBe(false)
    expect(out.action).toBe('register')
    expect(out.error).toMatch(/not authorized/)
  })

  it('rejects an unknown subcommand', () => {
    expect(() => run('scopes bogus')).toThrow()
  })

  it('surfaces an unreachable remote instead of a silent empty offer (#656)', () => {
    // a remote store that refuses the connection — discovery fails
    writeFileSync(
      join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "http://127.0.0.1:9"\n    token: "x"\n    scope: "group:acme/team"\n`,
    )
    const out = JSON.parse(run('scopes'))
    expect(out.success).toBe(false)
    expect(out.action).toBe('list')
    expect(out.scopes).toEqual([])
    expect(out.failures.length).toBeGreaterThan(0)
  })
})
