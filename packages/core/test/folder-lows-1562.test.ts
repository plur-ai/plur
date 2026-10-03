/**
 * Folder-map lows from the 0.21.1 pre-release check (#1562):
 *
 *  (a) the broken-map warning says memory is paused and names the repair
 *      command (it said "treating it as empty (folders fall back to ask)");
 *  (b) `plur folders set` / `rm` keep the user's comments and blank lines;
 *  (c) "Yes, without its settings" never carries a team scope;
 *  (d) a question issued by a host process (the opencode plugin) can be
 *      shown again, with the same nonces, by a child of that host (its MCP
 *      server), instead of a second set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  Plur, folderAsk, hostFolderAsk, resolveFolderPolicy, folderMapPath, loadFolderMap, endFolderNonceSession,
} from '../src/index.js'
import { logger } from '../src/logger.js'

let root: string
let work: string
const TEAM = 'group:acme/eng'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lows-1562-home-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'lows-1562-work-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

function mk(name: string): string {
  const d = join(work, name)
  mkdirSync(d, { recursive: true })
  return realpathSync(d)
}

function config(scopes: string[]): void {
  writeFileSync(join(root, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n${scopes.map(s => `  - url: "http://127.0.0.1:9"\n    token: "t"\n    scope: "${s}"\n`).join('')}`)
}

describe('(a) the broken-map warning says memory is paused', () => {
  it('names the problem, says memory is paused until the map is fixed, and names plur folders repair', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    const d = mk('a')
    writeFileSync(folderMapPath(root), `version: 1\nfolders:\n  - path: "${d}"\n\tplur: on\n`)
    expect(resolveFolderPolicy(d, { root }).mode).toBe('ask')
    const msg = warn.mock.calls.map(c => String(c[0])).find(m => m.includes(folderMapPath(root)))
    expect(msg, JSON.stringify(warn.mock.calls)).toBeDefined()
    expect(msg).not.toMatch(/treating it as empty|fall back to ask/)
    expect(msg).toMatch(/paused/)
    expect(msg).toMatch(/until (the map|it) is fixed/)
    expect(msg).toContain('plur --path')
    expect(msg).toContain('folders repair')
  })

  it('a map that cannot be read at all says the same', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    const d = mk('a2')
    mkdirSync(folderMapPath(root))  // a directory where the file should be: cannot be read
    expect(resolveFolderPolicy(d, { root }).mode).toBe('ask')
    const msg = warn.mock.calls.map(c => String(c[0])).find(m => m.includes(folderMapPath(root)))
    expect(msg).toBeDefined()
    expect(msg).not.toMatch(/treating it as empty/)
    expect(msg).toMatch(/paused/)
  })
})

describe('(b) plur folders set / rm keep comments and blank lines', () => {
  const HAND = (a: string, b: string) => [
    '# My folder map. PLUR: please keep this comment.',
    'version: 1',
    '',
    'folders:',
    '  # work projects',
    `  - path: "${a}"`,
    '    plur: on   # always on',
    '',
    '  # side project, keep quiet',
    `  - path: "${b}"`,
    '    plur: off',
    '',
    '# end of file',
    '',
  ].join('\n')

  it('adding a folder keeps every existing line and appends the new entry', () => {
    const a = mk('a'), b = mk('b'), c = mk('c')
    writeFileSync(folderMapPath(root), HAND(a, b))
    const plur = new Plur({ path: root })
    plur.setFolder(c, { mode: 'on' })
    const text = readFileSync(folderMapPath(root), 'utf8')
    for (const line of HAND(a, b).split('\n').filter(Boolean)) expect(text, text).toContain(line)
    expect(text).toContain('\n\n')
    expect(loadFolderMap(root).folders).toEqual([
      { path: a, plur: 'on' }, { path: b, plur: 'off' }, { path: c, plur: 'on' },
    ])
  })

  it('changing a folder rewrites only its own lines', () => {
    const a = mk('a'), b = mk('b')
    config([TEAM])
    writeFileSync(folderMapPath(root), HAND(a, b))
    const plur = new Plur({ path: root })
    plur.setFolder(b, { scope: TEAM })
    const text = readFileSync(folderMapPath(root), 'utf8')
    for (const keep of ['# My folder map. PLUR: please keep this comment.', '  # work projects', '    plur: on   # always on',
      '  # side project, keep quiet', '# end of file']) expect(text, text).toContain(keep)
    expect(loadFolderMap(root).folders).toEqual([{ path: a, plur: 'on' }, { path: b, scope: TEAM }])
  })

  it('removing a folder drops only its lines', () => {
    const a = mk('a'), b = mk('b')
    writeFileSync(folderMapPath(root), HAND(a, b))
    const plur = new Plur({ path: root })
    expect(plur.removeFolder(b)).toBe(true)
    const text = readFileSync(folderMapPath(root), 'utf8')
    expect(text).toContain('# My folder map. PLUR: please keep this comment.')
    expect(text).toContain('    plur: on   # always on')
    expect(text).toContain('# end of file')
    expect(text).not.toContain(b)
    expect(loadFolderMap(root).folders).toEqual([{ path: a, plur: 'on' }])
  })
})

describe('(c) "Yes, without its settings" never carries a team scope', () => {
  it('for an untrusted .plur.yaml it is --on, even with one other configured team scope', () => {
    // The repo asks for a scope that is not configured; the one configured
    // team scope is something else — before, that one rode on this answer.
    config([TEAM])
    const repo = mk('repo')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:other/team\n')
    const policy = resolveFolderPolicy(repo, { root })
    expect(policy.reason).toBe('untrusted-plur-yaml')
    const ask = folderAsk({ dir: repo, policy, sessionId: 'sess-c', root, claim: () => true })!
    const without = ask.answers.find(a => a.label === 'Yes, without its settings')!
    expect(without, JSON.stringify(ask.answers)).toBeDefined()
    expect(without.command).toMatch(/ --on --nonce /)
    expect(without.command).not.toContain('--scope')
    expect(ask.text.split('\n').find(l => l.startsWith('- Yes, without its settings'))).not.toContain(TEAM)
  })
})

describe('(d) one set of question nonces per folder for a host and its MCP server', () => {
  it('a child of the host that asked gets the same question with the same nonces, naming its session', () => {
    const d = mk('d')
    const policy = resolveFolderPolicy(d, { root })
    const plugin = folderAsk({ dir: d, policy, sessionId: 'ses_oc1', root, claim: () => true, bindSession: true, hostPid: 4242 })!
    expect(plugin.nonces.length).toBeGreaterThan(0)
    const shown = hostFolderAsk({ dir: d, policy, root, hostPids: [77, 4242] })!
    expect(shown, 'no host question found').not.toBeNull()
    expect([...shown.nonces].sort()).toEqual([...plugin.nonces].sort())
    for (const a of shown.answers) expect(a.command).toMatch(/ --session ses_oc1$/)
    // One of them works, from the session it names.
    const yes = shown.answers.find(a => /^Yes/.test(a.label))!
    const nonce = / --nonce ([0-9a-f]+)/.exec(yes.command)![1]
    const plur = new Plur({ path: root })
    expect(plur.setFolder(d, { mode: 'on' }, { nonce, session: 'ses_oc1' }).plur).toBe('on')
  })

  it('no question from that host, another folder, or an ended session: nothing to reuse', () => {
    const d = mk('d'), other = mk('other')
    const policy = resolveFolderPolicy(d, { root })
    folderAsk({ dir: d, policy, sessionId: 'ses_oc2', root, claim: () => true, bindSession: true, hostPid: 4242 })
    expect(hostFolderAsk({ dir: d, policy, root, hostPids: [77] })).toBeNull()
    expect(hostFolderAsk({ dir: other, policy: resolveFolderPolicy(other, { root }), root, hostPids: [4242] })).toBeNull()
    endFolderNonceSession(root, 'ses_oc2')
    expect(hostFolderAsk({ dir: d, policy, root, hostPids: [4242] })).toBeNull()
  })

  it('a question issued without a host is never reused', () => {
    const d = mk('d')
    const policy = resolveFolderPolicy(d, { root })
    folderAsk({ dir: d, policy, sessionId: 'hook-1', root, claim: () => true })
    expect(hostFolderAsk({ dir: d, policy, root, hostPids: [process.pid, process.ppid] })).toBeNull()
  })
})
