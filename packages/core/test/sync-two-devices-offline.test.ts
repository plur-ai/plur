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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
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

/** Two devices cloned from one personal repository that holds `base`. */
async function twoDevices(base: string[]): Promise<{ A: Plur; B: Plur; dirA: string; dirB: string; remote: string; ids: string[] }> {
  tmp = mkdtempSync(join(tmpdir(), 'plur-two-devices-'))
  const remote = join(tmp, 'remote.git')
  git(['init', '--bare', '-q', '-b', 'main', remote], tmp)
  const dirA = join(tmp, 'a')
  const A = open(dirA)
  writeFileSync(join(dirA, 'config.yaml'), 'backend: yaml\n')
  const ids: string[] = []
  for (const s of base) ids.push((await A.learn(s, { scope: 'global' })).id)
  await A.sync(remote)
  const dirB = join(tmp, 'b')
  git(['clone', '-q', remote, dirB], tmp)
  writeFileSync(join(dirB, 'config.yaml'), 'backend: yaml\n')
  const B = open(dirB)
  await B.list()
  return { A, B, dirA, dirB, remote, ids }
}

const loadYaml = (dir: string, file: string): any => yaml.load(readFileSync(join(dir, file), 'utf8'))
const appendRecord = (dir: string, file: string, record: unknown) => {
  let list: unknown[] = []
  try { list = (loadYaml(dir, file) as unknown[]) ?? [] } catch { /* absent */ }
  writeFileSync(join(dir, file), yaml.dump([...list, record], { lineWidth: 120, noRefs: true }))
}

for (const order of ['A first', 'B first'] as const) {
  describe(`two different reviews minted under one daily id (${order})`, () => {
    it('keeps both reviews, episodes and candidates, with their statuses, on both devices', { timeout: 120_000 }, async () => {
      const { A, B, dirA, dirB } = await twoDevices([
        'Device A base fact: the API gateway times out after 30 seconds',
        'Device B base fact: the cache is flushed every night at two',
      ])
      const [wA, wB] = (await A.list()).sort((x, y) => x.statement.localeCompare(y.statement))
      const a1 = await A.learn('Device A new fact: the API gateway times out after 60 seconds', { scope: 'global' })
      const b1 = await B.learn('Device B new fact: the cache is flushed every hour', { scope: 'global' })
      const pair = (x: { id: string; statement: string }, y: { id: string; statement: string }) =>
        ({ id_a: x.id, id_b: y.id, statement_a: x.statement, statement_b: y.statement, confidence: 0.9, reason: 'they disagree' })
      const tA = (await A.recordTensions([pair(wA, a1)])).records[0]
      const tB = (await B.recordTensions([pair(wB, b1)])).records[0]
      expect(tA.id, 'precondition: both devices minted the same review id').toBe(tB.id)
      // One review resolved, the other still pending.
      await A.resolveTension(tA.id, a1.id)
      // Episodes and candidates use the same record merge.
      appendRecord(dirA, 'episodes.yaml', { id: 'EP-same-id', summary: 'Device A session', timestamp: '2026-10-20T10:00:00.000Z' })
      appendRecord(dirB, 'episodes.yaml', { id: 'EP-same-id', summary: 'Device B session', timestamp: '2026-10-20T11:00:00.000Z' })
      appendRecord(dirA, 'candidates.yaml', { id: 'C-same-id', note: 'Device A candidate' })
      appendRecord(dirB, 'candidates.yaml', { id: 'C-same-id', note: 'Device B candidate' })

      const [first, second] = order === 'A first' ? [A, B] : [B, A]
      await first.sync()
      await second.sync()
      await first.sync()

      for (const [name, dir] of [['A', dirA], ['B', dirB]] as const) {
        const p = open(dir)
        const engrams = (await p.list({ includeRetired: true } as any)).concat(await p.list())
        const idOf = (statement: string) => engrams.find(e => e.statement === statement)?.id
          ?? ((loadYaml(dir, 'engrams.yaml').engrams as any[]).find(e => e.statement === statement)?.id)
        const reviews = p.listTensions()
        expect(new Set(reviews.map(r => r.id)).size, `${name}: review ids unique`).toBe(reviews.length)
        const revA = reviews.find(r => r.statement_b === a1.statement)
        const revB = reviews.find(r => r.statement_b === b1.statement)
        expect(revA, `${name} lost device A's review (reviews: ${JSON.stringify(reviews)})`).toBeTruthy()
        expect(revB, `${name} lost device B's review (reviews: ${JSON.stringify(reviews)})`).toBeTruthy()
        expect(revA!.status).toBe('resolved')
        expect(revB!.status).toBe('detected')
        expect(revA!.statement_a).toBe(wA.statement)
        expect(revB!.statement_a).toBe(wB.statement)
        // Each review still names its own device's memories.
        expect(revA!.engram_b).toBe(idOf(a1.statement))
        expect(revB!.engram_b).toBe(idOf(b1.statement))
        const episodes = loadYaml(dir, 'episodes.yaml') as Array<{ id: string; summary: string }>
        expect(episodes.map(e => e.summary), `${name} episodes`).toEqual(expect.arrayContaining(['Device A session', 'Device B session']))
        expect(new Set(episodes.map(e => e.id)).size).toBe(episodes.length)
        const candidates = loadYaml(dir, 'candidates.yaml') as Array<{ id: string; note: string }>
        expect(candidates.map(c => c.note), `${name} candidates`).toEqual(expect.arrayContaining(['Device A candidate', 'Device B candidate']))
        expect(new Set(candidates.map(c => c.id)).size).toBe(candidates.length)
      }
      expect(git(['rev-parse', 'HEAD'], dirA).trim()).toBe(git(['rev-parse', 'HEAD'], dirB).trim())
    })
  })
}

describe('a renamed memory and the records held aside for privacy', () => {
  it('every local reference follows the rename, and withheld content stays off the remote', { timeout: 120_000 }, async () => {
    const { A, B, dirA, dirB, remote } = await twoDevices(['A shared base fact both devices start from'])
    const a1 = await A.learn('Device A: the release train leaves on Thursdays', { scope: 'global' })
    const b1 = await B.learn('Device B: the build cache lives in the shared bucket', { scope: 'global' })
    expect(a1.id, 'precondition: both devices minted the same memory id').toBe(b1.id)
    const local = await B.learn('Device B private note: the bucket key is in my keychain', { scope: 'local' })
    // The machine-local memory points at B's new memory.
    const store = loadYaml(dirB, 'engrams.yaml')
    const rec = store.engrams.find((e: any) => e.id === local.id)
    rec.relations = { ...(rec.relations ?? {}), related: [b1.id] }
    writeFileSync(join(dirB, 'engrams.yaml'), yaml.dump(store, { lineWidth: 120, noRefs: true }))
    // An episode and a review that name both — held aside, since they name the local memory.
    const ep = B.capture(`Private session about ${b1.id} and ${local.id}`)
    await B.recordTensions([{ id_a: b1.id, id_b: local.id, statement_a: b1.statement, statement_b: local.statement, confidence: 0.8, reason: 'private check' }])

    await A.sync()
    await B.sync()
    await A.sync()

    const reopened = open(dirB)
    const all = loadYaml(dirB, 'engrams.yaml').engrams as any[]
    const bNow = all.find(e => e.statement === b1.statement)
    const aNow = all.find(e => e.statement === a1.statement)
    expect(bNow && aNow).toBeTruthy()
    expect(aNow.id, 'the pushed memory keeps the id').toBe(a1.id)
    expect(bNow.id, 'the unpushed memory was renamed').not.toBe(b1.id)
    const localNow = all.find(e => e.id === local.id)
    expect(localNow, 'the machine-local memory is back').toBeTruthy()
    expect(localNow.relations?.related ?? [], 'local relation follows the rename').toEqual([bNow.id])
    const episode = (loadYaml(dirB, 'episodes.yaml') as any[]).find(e => e.id === ep.id)
    expect(episode, 'the held episode is back').toBeTruthy()
    expect(episode.summary).toBe(`Private session about ${bNow.id} and ${local.id}`)
    const review = reopened.listTensions().find(r => r.statement_b === local.statement)
    expect(review, 'the held review is back').toBeTruthy()
    expect(review!.engram_a, 'held review follows the rename').toBe(bNow.id)
    expect(review!.engram_b).toBe(local.id)

    // Withheld content never reached the remote.
    const remoteText = ['engrams.yaml', 'episodes.yaml', 'tensions.yaml']
      .map(f => { try { return git(['show', `main:${f}`], remote) } catch { return '' } }).join('\n')
    expect(remoteText).not.toContain(local.statement)
    expect(remoteText).not.toContain(local.id)
    expect(remoteText).not.toContain('Private session about')
    expect(remoteText).toContain(b1.statement)
    void dirA
  })
})

/**
 * Audit 6, N1: the record merge renames device B's unpushed memory, and B's
 * machine-local records (held aside during the pull) must follow that rename.
 * In an uninterrupted sync the rename map is passed in memory. Here B's sync
 * runs in a child process that is really killed (SIGKILL, no `finally`) at a
 * point of the merge, through a `git` on PATH that kills its parent there:
 * - during the record merge, before the rename map is saved;
 * - after the map is saved, just before the merge commit;
 * - right after the merge commit (the audit's reproduction).
 * The next sync must leave every held reference naming B's memory.
 */
const SYNC_SRC = join(__dirname, '../src/sync.ts')
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

function killingGit(dir: string): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ -f .git/MERGE_HEAD ]; then
  case "$KILL_AT:$1" in
    before-map:add|before-commit:commit) kill -KILL $PPID; sleep 30 ;;
    after-commit:commit) "${REAL_GIT}" "$@"; kill -KILL $PPID; sleep 30 ;;
  esac
fi
exec "${REAL_GIT}" "$@"
`, { mode: 0o755 })
  return bin
}

for (const killAt of ['before-map', 'before-commit', 'after-commit'] as const) {
  describe(`a sync killed during the merge that renames a memory (${killAt})`, () => {
    it('the restart leaves every held reference on the renamed memory', { timeout: 120_000 }, async () => {
      const { A, B, dirA, dirB, remote } = await twoDevices(['A shared base fact both devices start from'])
      const a1 = await A.learn('Device A: the release train leaves on Thursdays', { scope: 'global' })
      const b1 = await B.learn('Device B: the build cache lives in the shared bucket', { scope: 'global' })
      expect(a1.id, 'precondition: both devices minted the same memory id').toBe(b1.id)
      const local = await B.learn('Device B private note: the bucket key is in my keychain', { scope: 'local' })
      const store = loadYaml(dirB, 'engrams.yaml')
      store.engrams.find((e: any) => e.id === local.id).relations = { related: [b1.id] }
      writeFileSync(join(dirB, 'engrams.yaml'), yaml.dump(store, { lineWidth: 120, noRefs: true }))
      const ep = B.capture(`Private session about ${b1.id} and ${local.id}`)
      await A.sync()

      const bin = killingGit(tmp)
      const script = join(tmp, 'child.mts')
      writeFileSync(script, `const { sync } = await import(${JSON.stringify(SYNC_SRC)}); sync(${JSON.stringify(dirB)})\n`)
      let death: any
      try {
        execFileSync(process.execPath, ['--import', 'tsx', script], {
          cwd: join(__dirname, '..'), stdio: 'pipe', timeout: 60_000,
          env: { ...process.env, KILL_AT: killAt, PATH: `${bin}:${process.env.PATH}` },
        })
      } catch (err) { death = err }
      expect(death?.signal, 'the child sync was killed').toBe('SIGKILL')
      expect(existsSync(join(dirB, '.git', 'plur-held.json')), 'held records are in the recovery file').toBe(true)
      const subject = git(['log', '-1', '--format=%s'], dirB)
      if (killAt === 'after-commit') expect(subject).toContain('merged both devices')
      else expect(subject).not.toContain('merged both devices')

      if (killAt === 'after-commit') {
        // Before any restart, a reader already sees the held relation on B's memory.
        const view = await open(dirB).getById(local.id)
        const bView = (await open(dirB).list()).find(e => e.statement === b1.statement)!
        expect(bView.id, 'the merge renamed B').not.toBe(b1.id)
        expect((view as any)?.relations?.related, 'reader view of the held relation').toEqual([bView.id])
      }

      await open(dirB).sync()
      await A.sync()
      await open(dirB).sync()

      const all = loadYaml(dirB, 'engrams.yaml').engrams as any[]
      const bNow = all.find(e => e.statement === b1.statement)
      const aNow = all.find(e => e.statement === a1.statement)
      expect(aNow.id, 'the pushed memory keeps the id').toBe(a1.id)
      expect(bNow.id, 'the unpushed memory was renamed').not.toBe(b1.id)
      expect(all.filter(e => e.statement === b1.statement)).toHaveLength(1)
      const localNow = all.find(e => e.id === local.id)
      expect(localNow, 'the machine-local memory is back').toBeTruthy()
      expect(localNow.relations?.related ?? [], 'local relation follows the rename').toEqual([bNow.id])
      const episode = (loadYaml(dirB, 'episodes.yaml') as any[]).filter(e => e.id === ep.id)
      expect(episode).toHaveLength(1)
      expect(episode[0].summary, 'held episode follows the rename').toBe(`Private session about ${bNow.id} and ${local.id}`)
      expect(existsSync(join(dirB, '.git', 'plur-held.json')), 'recovery finished').toBe(false)
      expect(existsSync(join(dirB, '.git', 'MERGE_HEAD')), 'no merge left half-done').toBe(false)
      const remoteText = ['engrams.yaml', 'episodes.yaml']
        .map(f => { try { return git(['show', `main:${f}`], remote) } catch { return '' } }).join('\n')
      expect(remoteText).not.toContain(local.statement)
      expect(remoteText).not.toContain(local.id)
      expect(remoteText).toContain(b1.statement)
      expect(git(['rev-parse', 'HEAD'], dirA).trim()).toBe(git(['rev-parse', 'HEAD'], dirB).trim())
    })
  })
}

/**
 * Audit 6, N3: both devices reviewed the SAME memory pair. That is one review:
 * after syncing there is exactly one record for the unordered pair, and a
 * terminal state (resolved with its winner and time, or dismissed) is never
 * replaced by 'detected' or 'confirmed' from the other device.
 */
const pairReview = (id: string, x: string, y: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, engram_a: x, engram_b: y, statement_a: `statement of ${x}`, statement_b: `statement of ${y}`,
  confidence: 0.9, reason: 'they disagree', detected_at: '2026-10-20T10:00:00.000Z', status,
  resolved_by: null, resolved_at: null, category: 'factual', ...extra,
})

const COMBOS = [['resolved', 'detected'], ['resolved', 'confirmed'], ['dismissed', 'detected'], ['dismissed', 'confirmed'], ['confirmed', 'detected']] as const

for (const order of ['A first', 'B first'] as const) {
  for (const ids of ['same id', 'different ids'] as const) {
    describe(`two devices reviewed the same pair (${order}, ${ids})`, () => {
      it('one record per pair survives and keeps the most advanced state', { timeout: 120_000 }, async () => {
        // One pair of memories per state combination; device A holds the first state.
        const { dirA, dirB, ids: m } = await twoDevices(COMBOS.flatMap((_, i) => [
          `Pair ${i} memory one: the gateway times out after ${i + 1}0 seconds`,
          `Pair ${i} memory two: the gateway times out after ${i + 1}5 seconds`,
        ]))
        const resolvedAt = '2026-10-20T11:00:00.000Z'
        const onA: unknown[] = [], onB: unknown[] = []
        COMBOS.forEach(([stA, stB], i) => {
          const [x, y] = [m[2 * i], m[2 * i + 1]]
          const n = (k: number) => `T-2026-1020-${String(k).padStart(3, '0')}`
          onA.push(pairReview(n(i + 1), x, y, stA, stA === 'resolved' ? { resolved_by: y, resolved_at: resolvedAt } : {}))
          // B saw the pair in the reverse order.
          onB.push(pairReview(ids === 'same id' ? n(i + 1) : n(i + 1 + COMBOS.length), y, x, stB))
        })
        writeFileSync(join(dirA, 'tensions.yaml'), yaml.dump(onA, { lineWidth: 120, noRefs: true }))
        writeFileSync(join(dirB, 'tensions.yaml'), yaml.dump(onB, { lineWidth: 120, noRefs: true }))
        const [first, second] = order === 'A first' ? [dirA, dirB] : [dirB, dirA]
        await open(first).sync()
        await open(second).sync()
        await open(first).sync()
        for (const [name, dir] of [['A', dirA], ['B', dirB]] as const) {
          const reviews = open(dir).listTensions()
          expect(reviews, `${name}: one record per pair (${JSON.stringify(reviews)})`).toHaveLength(COMBOS.length)
          COMBOS.forEach(([stA], i) => {
            const key = [m[2 * i], m[2 * i + 1]].sort().join(':')
            const ofPair = reviews.filter(r => [r.engram_a, r.engram_b].sort().join(':') === key)
            expect(ofPair, `${name}: pair ${i}`).toHaveLength(1)
            expect(ofPair[0].status, `${name}: pair ${i} state`).toBe(stA)
            expect(ofPair[0].resolved_by).toBe(stA === 'resolved' ? m[2 * i + 1] : null)
            expect(ofPair[0].resolved_at).toBe(stA === 'resolved' ? resolvedAt : null)
          })
        }
        expect(git(['rev-parse', 'HEAD'], dirA).trim()).toBe(git(['rev-parse', 'HEAD'], dirB).trim())
      })
    })
  }
}
