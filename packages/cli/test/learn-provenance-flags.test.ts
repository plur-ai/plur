/**
 * The command line must be able to record provenance, not only read it (#970).
 *
 * `plur learn` knew --scope/--type/--domain/--source and silently dropped
 * everything else. That was fixed once for Hermes' fields (#8) and the same gap
 * reopened for the provenance ones: `--license` looked accepted, was swallowed,
 * and the engram was written looking fine.
 *
 * A field with no way to set it makes "complete" unreachable, and a
 * completeness check nobody can satisfy is theatre.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur learn records who, what kind, and under which licence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-learn-prov-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (args: string[]) =>
    execFileSync('node', [CLI, ...args, '--path', dir, '--json'], { encoding: 'utf8', timeout: 30_000 }).trim()

  it('produces a record with nothing missing', () => {
    // Every field a record asks for, supplied from the command line alone.
    run(['learn', 'Deploys wait for migrations',
      '--license', 'cc-by-4.0', '--claim-class', 'asserted',
      '--asserted-by', 'local:maintainer', '--source', 'https://example.org/runbook'])

    const prov = JSON.parse(run(['provenance', 'ENG-2026-08-23-001']))
    expect(prov.complete).toBe(true)
    expect(prov.not_recorded).toEqual([])
    expect(prov.licence).toMatchObject({ name: 'cc-by-4.0', chosen: true })
    expect(prov.asserted_by).toBe('local:maintainer')
    expect(prov.claim_class).toBe('asserted')
  })

  it('marks the licence as unchosen when none is given', () => {
    run(['learn', 'Nobody picked a licence'])
    const prov = JSON.parse(run(['provenance', 'ENG-2026-08-23-001']))
    expect(prov.licence.chosen).toBe(false)
    expect(prov.complete).toBe(false)
  })

  it('refuses a claim class it does not know, rather than dropping it', () => {
    // Silently ignoring it is the worse failure: the engram is written, looks
    // fine, and is missing the field the caller believed they had set.
    let failed = false
    let message = ''
    try {
      execFileSync('node', [CLI, 'learn', 'x', '--claim-class', 'nonsense', '--path', dir],
        { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
    } catch (e: any) {
      failed = true
      message = String(e.stdout ?? '') + String(e.stderr ?? '')
    }
    expect(failed).toBe(true)
    expect(message).toContain('Unknown --claim-class')
    expect(message).toContain('observed')
  })

  it('accepts every claim class the schema allows', () => {
    for (const kind of ['observed', 'documented', 'structural', 'asserted', 'inferred', 'revised']) {
      expect(() => run(['learn', `A ${kind} statement`, '--claim-class', kind])).not.toThrow()
    }
  })

  it('carries an unrecognised licence through without inventing terms for it', () => {
    // A company-internal name is a real case. Record the name; claim nothing.
    run(['learn', 'Internal only', '--license', 'acme-internal-v3'])
    const prov = JSON.parse(run(['provenance', 'ENG-2026-08-23-001']))
    expect(prov.licence.name).toBe('acme-internal-v3')
    expect(prov.licence.chosen).toBe(true)
    expect(prov.licence.meaning).toBeUndefined()
  })

  it('documents all three flags in the usage text', () => {
    // The flags existed on the core API for a while with no way to reach them.
    let usage = ''
    try {
      execFileSync('node', [CLI, 'learn', '--path', dir], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
    } catch (e: any) { usage = String(e.stdout ?? '') + String(e.stderr ?? '') }
    for (const flag of ['--license', '--claim-class', '--asserted-by']) {
      expect(usage, `${flag} is not documented`).toContain(flag)
    }
  })
})
