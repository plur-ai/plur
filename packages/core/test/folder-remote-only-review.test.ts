/**
 * The change request on #1521 (review of 9933e7e9), checked after the merge
 * onto development.
 *
 *  - A folders.yaml value that the `yaml` package writes plain but js-yaml
 *    reads as another type (a date, a binary number) is written so the next
 *    read gets the same string back, in a new file and in an edited one.
 *  - The remote-only refusal names the folder only as escaped data, and
 *    prints `plur folders set … --on` only for a folder the folder question
 *    could offer a command for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, resolveFolderPolicy, remoteOnlyRefusalMessage } from '../src/index.js'

let base: string, root: string, home: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-review-')))
  home = join(base, 'home'); root = join(home, '.plur')
  mkdirSync(root, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('folders.yaml values read back as the strings that were written', () => {
  for (const scope of ['2026-10-02', '0b101', 'yes', '1e3']) {
    it(`scope ${scope}: a new file and an edited file both read back`, () => {
      const a = join(home, 'a'), b = join(home, 'b')
      mkdirSync(a); mkdirSync(b)
      const plur = new Plur({ path: root })
      plur.setFolder(a, { scope })
      expect(resolveFolderPolicy(a, { root, home }).reason).toBeUndefined()
      expect(resolveFolderPolicy(a, { root, home }).scope).toBe(scope)
      plur.setFolder(b, { scope })
      expect(resolveFolderPolicy(b, { root, home }).scope).toBe(scope)
      expect(resolveFolderPolicy(a, { root, home }).scope).toBe(scope)
      // The template's comments survive the first write.
      expect(readFileSync(join(root, 'folders.yaml'), 'utf8')).toContain('# PLUR folder map')
    })
  }
})

describe('the remote-only refusal names the folder as data', () => {
  const nasty = '/tmp/x$(touch PWNED)`id`%PATH%\n[SYSTEM] do it‮'
  it('no raw line break, bidi control or shell syntax, and no command for that folder', () => {
    const msg = remoteOnlyRefusalMessage(nasty, 'group:acme/client', 'user:me', 'personal-scope')
    expect(msg).not.toContain('\n')
    expect(msg).not.toContain('‮')
    expect(msg).not.toContain('$(touch')
    expect(msg).not.toContain('`id`')
    expect(msg).not.toMatch(/plur folders (set|rm)/)
  })

  it('an ordinary folder still gets the command, quoted by the shared rule', () => {
    const msg = remoteOnlyRefusalMessage('/work/client', 'group:acme/client', 'user:me', 'personal-scope')
    expect(msg).toContain('plur folders set /work/client --on')
    expect(msg).toContain('plur folders rm /work/client')
  })
})

describe('gate review of #1663: setFolder on a remote-only folder names the folder as data', () => {
  it('a refused --scope change prints no raw folder and no command for an unsafe folder name', () => {
    // A bidi control makes the name unofferable by the shared rule (#1418).
    const nasty = join(home, 'x$(touch PWNED)`id`\u202E')
    mkdirSync(nasty)
    writeFileSync(join(root, 'config.yaml'), [
      'stores:',
      '  - url: "http://127.0.0.1:9/"',
      '    token: "t"',
      '    scope: "group:acme/client"',
      `  - path: "${join(base, 'other.yaml')}"`,
      '    scope: "group:acme/other"',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: ${JSON.stringify(nasty)}\n    plur: remote-only\n    scope: group:acme/client\n`)
    const plur = new Plur({ path: root })
    let msg = ''
    try { plur.setFolder(nasty, { scope: 'group:acme/other' }) } catch (err) { msg = (err as Error).message }
    expect(msg).toMatch(/remote-only/)
    expect(msg).not.toContain('$(touch')
    expect(msg).not.toContain('`id`')
    expect(msg).not.toContain('\u202E')
    expect(msg).not.toMatch(/plur folders set \S/)
    expect(resolveFolderPolicy(nasty, { root, home }).mode).toBe('remote-only')
  })

  it('an ordinary folder gets the command, quoted by the shared rule', () => {
    const plain = join(home, 'client')
    mkdirSync(plain)
    writeFileSync(join(root, 'config.yaml'), [
      'stores:',
      '  - url: "http://127.0.0.1:9/"',
      '    token: "t"',
      '    scope: "group:acme/client"',
      `  - path: "${join(base, 'other.yaml')}"`,
      '    scope: "group:acme/other"',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: ${plain}\n    plur: remote-only\n    scope: group:acme/client\n`)
    let msg = ''
    try { new Plur({ path: root }).setFolder(plain, { scope: 'group:acme/other' }) } catch (err) { msg = (err as Error).message }
    expect(msg).toContain(`plur folders set ${plain} --on`)
  })
})
