/**
 * Two devices share one personal repository. Each changes the store offline
 * (A saves X and forgets Y; B saves Z and corrects W), then both sync, in
 * either order, and the first syncs again. Every change must survive on both
 * devices, the forgotten memory must stay forgotten, and the correction must
 * still point at the memory it replaces — in memory AND after a fresh reopen
 * of each store.
 *
 * Before the fix, the second device's sync threw "Sync conflict: YAML files
 * have merge conflicts…": both devices appended to engrams.yaml, git's line
 * merge conflicted, and sync aborted instead of merging the records.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { isolateGitConfig } from './helpers/git-isolation.js'

isolateGitConfig({ defaultBranch: 'main' })

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function open(dir: string): Plur {
  return new Plur({ path: dir, autoDiscover: false })
}

let tmp: string
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

for (const order of ['A first', 'B first'] as const) {
  describe(`two devices sync offline changes (${order})`, () => {
    it('keeps both sides, keeps the forget, keeps the correction link, and persists it', { timeout: 120_000 }, async () => {
      tmp = mkdtempSync(join(tmpdir(), 'plur-two-devices-'))
      const remote = join(tmp, 'remote.git')
      git(['init', '--bare', '-q', '-b', 'main', remote], tmp)

      const dirA = join(tmp, 'a')
      const A = open(dirA)
      writeFileSync(join(dirA, 'config.yaml'), 'backend: yaml\n')
      const y = await A.learn('The staging VPN password is kept on the old wiki page', { scope: 'global' })
      const w = await A.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
      await A.sync(remote)

      const dirB = join(tmp, 'b')
      git(['clone', '-q', remote, dirB], tmp)
      writeFileSync(join(dirB, 'config.yaml'), 'backend: yaml\n')
      const B = open(dirB)
      expect((await B.list()).map(e => e.id)).toEqual(expect.arrayContaining([y.id, w.id]))

      const x = await A.learn('Release notes go in CHANGELOG.md before tagging', { scope: 'global' })
      await A.forget(y.id, 'no longer true')
      const z = await B.learn('The office printer lives on the third floor', { scope: 'global' })
      const fix = await B.learn('Deploy the billing service with canary rollouts, not blue-green', { scope: 'global', supersedes: [w.id] })

      const [first, second] = order === 'A first' ? [A, B] : [B, A]
      await first.sync()
      await second.sync()
      await first.sync()

      const check = async (p: Plur, name: string) => {
        const active = await p.list()
        const statements = active.map(e => e.statement)
        for (const s of [x.statement, z.statement, fix.statement]) expect(statements, `${name} missing "${s}"`).toContain(s)
        expect(statements, `${name} brought back the forgotten memory`).not.toContain(y.statement)
        const hits = await p.recall('staging VPN password wiki', { limit: 10 })
        expect(hits.map(e => e.statement)).not.toContain(y.statement)
        const fixHere = active.find(e => e.statement === fix.statement)!
        const old = active.find(e => e.statement === w.statement) ?? await p.getById(w.id)
        expect(old, `${name} lost W`).toBeTruthy()
        expect(((old as any).relations?.superseded_by ?? []) as string[], `${name}: correction no longer replaces W`).toContain(fixHere.id)
        // Ids stay unique in the merged store.
        const all = (yaml.load(readFileSync(join(p.getStorageRoot(), 'engrams.yaml'), 'utf8')) as any).engrams as Array<{ id: string }>
        expect(new Set(all.map(e => e.id)).size).toBe(all.length)
        // Both devices minted the same next id offline: the unpushed one was
        // renamed (keep both, rename one), not dropped or overwritten.
        expect(all.some(e => /-D[0-9a-f]{8}/.test(e.id)), `${name}: no clash was renamed (ids: ${all.map(e => e.id).join(', ')})`).toBe(true)
      }
      await check(A, 'device A')
      await check(B, 'device B')
      // Persistent: a fresh process opening each store sees the same thing.
      await check(open(dirA), 'device A (reopened)')
      await check(open(dirB), 'device B (reopened)')
      // And the two devices agree on what the repository holds.
      expect(git(['rev-parse', 'HEAD'], dirA).trim()).toBe(git(['rev-parse', 'HEAD'], dirB).trim())
    })
  })
}

describe('a record changed on both devices', () => {
  it('a forget on one device wins over an unrelated edit on the other', { timeout: 120_000 }, async () => {
    tmp = mkdtempSync(join(tmpdir(), 'plur-two-devices-'))
    const remote = join(tmp, 'remote.git')
    git(['init', '--bare', '-q', '-b', 'main', remote], tmp)
    const dirA = join(tmp, 'a')
    const A = open(dirA)
    writeFileSync(join(dirA, 'config.yaml'), 'backend: yaml\n')
    const y = await A.learn('Old fact that one device forgets', { scope: 'global' })
    const keep = await A.learn('A fact both devices keep', { scope: 'global' })
    await A.sync(remote)
    const dirB = join(tmp, 'b')
    git(['clone', '-q', remote, dirB], tmp)
    writeFileSync(join(dirB, 'config.yaml'), 'backend: yaml\n')
    const B = open(dirB)
    await B.list()

    await A.forget(y.id, 'wrong')
    // B touches the same record (feedback changes its activation) and adds one.
    await B.feedback(y.id, 'positive')
    await B.learn('Another fact only device B saved', { scope: 'global' })
    await A.learn('Another fact only device A saved', { scope: 'global' })

    await B.sync()
    await A.sync()
    await B.sync()
    for (const d of [dirA, dirB]) {
      const p = open(d)
      const statements = (await p.list()).map(e => e.statement)
      expect(statements).not.toContain(y.statement)
      expect(statements).toEqual(expect.arrayContaining([keep.statement, 'Another fact only device B saved', 'Another fact only device A saved']))
    }
  })
})
