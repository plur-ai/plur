import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.js'
import { Plur } from '../src/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it.each(['', 'null', '[]', 'auto_learn: false\nembeddings: [', 'auto_capture: false\ninjection_budget: invalid'])('does not replace an existing invalid config with permissive defaults: %j', source => {
  const root = mkdtempSync(join(tmpdir(), 'plur-config-audit-')); roots.push(root)
  const file = join(root, 'config.yaml'); writeFileSync(file, source)
  expect(() => loadConfig(file)).toThrow(/config/)
  expect(() => new Plur({ path: root, autoDiscover: false })).toThrow(/config/)
  expect(readFileSync(file, 'utf8')).toBe(source)
})

it('does not include a secret-containing YAML source line in its error', () => {
  const root = mkdtempSync(join(tmpdir(), 'plur-config-audit-')); roots.push(root)
  const file = join(root, 'config.yaml'); writeFileSync(file, 'token: [audit-secret-value')
  try { loadConfig(file); throw new Error('must reject') } catch (error) {
    expect(String(error)).not.toContain('audit-secret-value')
    expect(String(error)).toContain('cannot read or parse')
  }
})

it.each(['read', 'stamp'] as const)('migration config %s refuses malformed YAML without exposing or changing its contents', async operation => {
  const { getSchemaVersion, setSchemaVersion } = await import('../src/migrations/runner.js')
  const root = mkdtempSync(join(tmpdir(), 'plur-migration-config-audit-')); roots.push(root)
  const file = join(root, 'config.yaml')
  const source = 'token: [audit-secret-value\n'
  writeFileSync(file, source)
  let failure: unknown
  try { operation === 'read' ? getSchemaVersion(file) : setSchemaVersion(file, 1) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).not.toContain('audit-secret-value')
  expect(readFileSync(file, 'utf8')).toBe(source)
})
