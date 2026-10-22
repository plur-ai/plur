import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { cleanupLegacyPlurYaml, cleanupLegacyProjectAtSessionStart } from '../src/lib/legacy-plur-yaml.js'

let root: string, repo: string, file: string, backupRoot: string
const old = 'remote_url: https://memory.example.test\nremote_token: fixture-private-key\nremote_scopes:\n  - project:example/team/app\n# remote_token is sensitive — keep .plur.yaml in .gitignore.\n'
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-legacy-yaml-')))
  repo = join(root, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo])
  file = join(repo, '.plur.yaml'); backupRoot = join(root, 'backups')
  writeFileSync(file, old); writeFileSync(join(repo, '.gitignore'), '.plur.yaml\n')
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.plur.yaml\n'); rmSync(root, { recursive: true, force: true }) })
const clean = (isTracked: (path: string) => boolean | null = () => false) => cleanupLegacyPlurYaml(repo, { isTracked, now: () => new Date('2026-01-01T00:00:00Z'), backupRoot })
it('backs up an untracked installer-only file privately before deleting it', () => {
  expect(clean()).toEqual({ path: file, outcome: 'deleted' }); expect(existsSync(file)).toBe(false)
  const backup = join(backupRoot, readdirSync(backupRoot)[0], '.plur.yaml')
  expect(readFileSync(backup, 'utf8')).toBe(old)
  if (process.platform !== 'win32') expect(lstatSync(backup).mode & 0o077).toBe(0)
})
it('preserves unrelated configuration bytes', () => {
  writeFileSync(file, 'domain: software\n' + old)
  expect(clean().outcome).toBe('stripped'); expect(readFileSync(file, 'utf8')).toBe('domain: software\n')
})
it('leaves a tracked token file untouched', () => {
  execFileSync('git', ['-C', repo, 'add', '-f', '.plur.yaml'])
  expect(clean(path => { execFileSync('git', ['-C', repo, 'ls-files', '--error-unmatch', path]); return true }).outcome).toBe('tracked-token')
  expect(readFileSync(file, 'utf8')).toBe(old); expect(existsSync(backupRoot)).toBe(false)
})
it('leaves a symlink and its target untouched', () => {
  const target = join(root, 'target'); writeFileSync(target, old); rmSync(file); symlinkSync(target, file)
  expect(clean().outcome).toBe('symlink-skipped'); expect(lstatSync(file).isSymbolicLink()).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe(old)
})
it('unknown tracking cannot authorize an edit', () => {
  expect(clean(() => null).outcome).toBe('unknown-tracking'); expect(readFileSync(file, 'utf8')).toBe(old)
})
it('failed backup leaves the original untouched', () => {
  writeFileSync(backupRoot, 'not a directory')
  expect(() => clean()).toThrow(); expect(readFileSync(file, 'utf8')).toBe(old)
})
it('an edit during the final Git check is preserved', () => {
  let calls = 0
  const changed = old + 'domain: newly-edited\n'
  expect(() => clean(() => { if (++calls === 2) writeFileSync(file, changed); return false })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(changed)
})
it('does not edit a tracked file without a token either', () => {
  const text = 'remote_url: https://memory.example.test\ndomain: software\n'; writeFileSync(file, text)
  expect(clean(() => true).outcome).toBe('none'); expect(readFileSync(file, 'utf8')).toBe(text)
})
it('finds the nearest config from a repository subdirectory', () => {
  const sub = join(repo, 'src'); mkdirSync(sub)
  expect(cleanupLegacyPlurYaml(sub, { isTracked: () => false, now: () => new Date(), backupRoot }).outcome).toBe('deleted')
})
it('does nothing without an enterprise registration and cleans up after registration', () => {
  writeFileSync(join(root, 'config.yaml'), 'stores: []\n')
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([]); expect(readFileSync(file, 'utf8')).toBe(old)
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test', scope: 'user:example:fixture', enterprise: {} }] }))
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([]); expect(existsSync(file)).toBe(false)
})
it('warns about tracked tokens without exposing the token', () => {
  execFileSync('git', ['-C', repo, 'add', '-f', '.plur.yaml'])
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test', scope: 'user:example:fixture', enterprise: {} }] }))
  const lines = cleanupLegacyProjectAtSessionStart(repo, root)
  expect(lines.join('\n')).toContain('ask your PLUR admin to revoke it')
  expect(lines.join('\n')).not.toContain('fixture-private-key'); expect(readFileSync(file, 'utf8')).toBe(old)
})
it('a legacy server entry without an enterprise block cannot authorize cleanup', () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test', scopes: ['user:example:fixture'] }] }))
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe(old); expect(existsSync(backupRoot)).toBe(false)
})
it('a registered enterprise server with no discovered scopes still authorizes cleanup', () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test', scopes: [], enterprise: { mode: 'full' } }] }))
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([]); expect(existsSync(file)).toBe(false)
})
it.each([{ url: 'not-a-url', enterprise: {} }, { url: 'https://memory.example.test', token: 42, enterprise: {} }])('a malformed registration never authorizes cleanup: %j', entry => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [entry] }))
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe(old); expect(existsSync(backupRoot)).toBe(false)
})
it('an alternate Git index cannot make a tracked token eligible for cleanup', () => {
  execFileSync('git', ['-C', repo, 'add', '-f', '.plur.yaml'])
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test', scope: 'user:example:fixture', enterprise: {} }] }))
  vi.stubEnv('GIT_INDEX_FILE', join(root, 'alternate-index'))
  cleanupLegacyProjectAtSessionStart(repo, root)
  expect(readFileSync(file, 'utf8')).toBe(old); expect(existsSync(backupRoot)).toBe(false)
})
it('emits a safe tracked-token warning before later injection can fail', () => {
  execFileSync('git', ['-C', repo, 'add', '-f', '.plur.yaml'])
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test', scope: 'user:example:fixture', enterprise: {} }] }))
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  cleanupLegacyProjectAtSessionStart(repo, root)
  expect(stderr.mock.calls.flat().join('')).toContain('ask your PLUR admin to revoke it')
  expect(stderr.mock.calls.flat().join('')).not.toContain('fixture-private-key')
})
it('malformed registration config leaves project bytes intact and never prints YAML secrets', () => {
  writeFileSync(join(root, 'config.yaml'), 'stores: [\n token: fixture-private-key\n invalid: [')
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe(old)
  expect(stderr.mock.calls.flat().join('')).not.toContain('fixture-private-key')
  expect(stderr.mock.calls.flat().join('')).toContain('manual review')
})
it('nested unrelated YAML survives without being mistaken for installer fields', () => {
  const unrelated = 'settings:\n  remote_token: retain-this-local-value\n'
  writeFileSync(file, old + unrelated)
  expect(clean().outcome).toBe('stripped'); expect(readFileSync(file, 'utf8')).toBe(unrelated)
})
// Release audit 0.22.0: the old fields are this project's link to a team
// server, and core still follows it. Registering one server must not cut a
// project's link to a different one.
it('leaves a link to a different server untouched', () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://other.example.test/sse', scope: 'user:example:fixture', enterprise: {} }] }))
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe(old); expect(existsSync(backupRoot)).toBe(false)
})
it('cleans up a link to the registered server even when the paths differ', () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url: 'https://memory.example.test/sse', scope: 'user:example:fixture', enterprise: {} }] }))
  expect(cleanupLegacyProjectAtSessionStart(repo, root)).toEqual([]); expect(existsSync(file)).toBe(false)
})
