import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import yaml from 'js-yaml'
import { Plur, loadFolderMap, folderMapPath, skippedStoreHintClaimed, claimSkippedStoreHint } from '../src/index.js'
import { planFolderMapRepair } from '../src/folder-map-check.js'

const DIST = join(__dirname, '..', 'dist', 'index.js')

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-fr-writes-'))) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Run an ES module snippet against core's built dist in a separate process. */
function child(code: string): Promise<number> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import * as core from ${JSON.stringify(DIST)};\nimport * as fs from 'fs';\n${code}`], { stdio: ['ignore', 'ignore', 'inherit'] })
    p.on('error', rej)
    p.on('exit', c => res(c ?? 1))
  })
}

describe('the skipped-store hint lookup never writes (formal folder-rules)', () => {
  const saved = process.env.TMPDIR
  afterEach(() => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved })

  it('with no marker folder, the lookup creates none', () => {
    process.env.TMPDIR = base
    expect(skippedStoreHintClaimed('s1', join(base, 'proj'))).toBe(false)
    expect(existsSync(join(base, 'plur-sessions'))).toBe(false)
  })

  it('with a marker folder, the lookup adds and removes nothing', () => {
    process.env.TMPDIR = base
    expect(claimSkippedStoreHint('s1', join(base, 'proj'))).toBe(true)
    const before = readdirSync(join(base, 'plur-sessions')).sort()
    expect(skippedStoreHintClaimed('s1', join(base, 'proj'))).toBe(true)
    expect(skippedStoreHintClaimed('s2', join(base, 'other'))).toBe(false)
    expect(readdirSync(join(base, 'plur-sessions')).sort()).toEqual(before)
  })
})

describe('repair re-indents only a map that does not parse (formal folder-rules)', () => {
  it('a parseable map with a wrong mode keeps its own indentation', () => {
    const text = 'version: 1\nfolders:\n    - path: /a\n      plur: Off\n    - path: /b\n      plur: ask\n'
    expect(() => yaml.load(text)).not.toThrow()
    const p = planFolderMapRepair(text)
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    expect(p.after).toBe(text.replace('plur: Off', 'plur: off'))
  })
})

describe('folder-map writes across processes (formal folder-rules)', () => {
  it('importing trust.yaml never overwrites a map another writer created meanwhile', async () => {
    const root = join(base, 'home')
    mkdirSync(root)
    writeFileSync(join(root, 'trust.yaml'), yaml.dump({ trusted: [join(base, 'legacy')] }))
    const theirs = 'version: 1\nfolders:\n  - path: /theirs\n    plur: off\n'
    const signal = join(base, 'locked')
    // The other writer holds the folder-map lock, creates folders.yaml, then releases.
    const other = child(
      `core.withLock(core.folderMapPath(${JSON.stringify(root)}), () => {` +
      ` fs.writeFileSync(${JSON.stringify(signal)}, '1');` +
      ` Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);` +
      ` fs.writeFileSync(core.folderMapPath(${JSON.stringify(root)}), ${JSON.stringify(theirs)});` +
      ` }, { maxRetries: 0 })`,
    )
    for (let i = 0; i < 200 && !existsSync(signal); i++) sleep(20)
    expect(existsSync(signal)).toBe(true)
    expect(existsSync(folderMapPath(root))).toBe(false)
    const map = loadFolderMap(root)
    expect(await other).toBe(0)
    expect(readFileSync(folderMapPath(root), 'utf8')).toBe(theirs)
    expect(map.folders.map(e => e.path)).toEqual(['/theirs'])
  })

  it('parallel folder-map writes from several processes lose none', async () => {
    const root = join(base, 'home')
    mkdirSync(root)
    const N = 6, PER = 4
    const runs = Array.from({ length: N }, (_, k) => child(
      `for (let j = 0; j < ${PER}; j++) core.setFolderEntry(${JSON.stringify(root)}, ${JSON.stringify(base)} + '/w${k}-' + j, { mode: 'off' }, { configuredScopes: [] })`,
    ))
    expect(await Promise.all(runs)).toEqual(Array(N).fill(0))
    const paths = loadFolderMap(root, true).folders.map(e => e.path).sort()
    const want = Array.from({ length: N * PER }, (_, i) => join(base, `w${Math.floor(i / PER)}-${i % PER}`)).sort()
    expect(paths).toEqual(want)
  }, 30_000)
})

describe('binding a folder never imports a legacy trust.yaml (formal folder-rules)', () => {
  it('bindFolder honours the legacy grant and writes no folders.yaml', () => {
    const root = join(base, 'home')
    const proj = join(base, 'proj')
    mkdirSync(root)
    mkdirSync(proj)
    writeFileSync(join(root, 'trust.yaml'), yaml.dump({ trusted: [proj] }))
    const trustBefore = readFileSync(join(root, 'trust.yaml'), 'utf8')
    const plur = new Plur({ path: root, autoDiscover: false })
    expect(existsSync(folderMapPath(root))).toBe(false)
    const policy = plur.bindFolder(proj, { home: base })
    expect(policy.mode).toBe('on')
    expect(existsSync(folderMapPath(root))).toBe(false)
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toBe(trustBefore)
  })
})
