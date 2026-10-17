// SYN-6: A shared sync never reveals a private memory through a side record (an episode, candidate, contradiction record or history entry), and memories kept to this machine are never synced anywhere.
//
// Side records are the files next to engrams.yaml that carry text or ids taken
// from memories: episodes.yaml (a failure report, a session note naming a
// memory), candidates.yaml (pending contradiction pairs, legacy), tensions.yaml
// (contradiction records with both statements copied in) and history/ (the
// per-memory event log). The eval writes each kind through PLUR where PLUR
// has a writer, then clones the repository and reads EVERY file it received,
// not only engrams.yaml, for the private memory's text and id.
//
// Positive controls: the cleared team memory arrives, and side records about
// cleared memories arrive too, so "nothing private arrived" cannot pass on a
// repository that received no side records at all.
//
// "Kept to this machine" = scope local (README: "machine-specific by design ...
// never reach any remote"). Its text and id must reach neither a personal nor
// a shared repository, through engrams.yaml or any side record.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, cloneRemote, isolateGit } from '../helpers/sync-packs-durability-history-git.js'

const tension = (a: { id: string; statement: string }, b: { id: string; statement: string }) => ({
  id_a: a.id, id_b: b.id, statement_a: a.statement, statement_b: b.statement, confidence: 0.9, reason: 'eval: they disagree',
})

/** The side records PLUR derives from a memory: a session note and a contradiction record, plus a legacy candidate. */
async function sideRecordsAbout(plur: Plur, dir: string, m: { id: string; statement: string }, other: { id: string; statement: string }): Promise<void> {
  plur.capture(`Session note: applied ${m.id} ("${m.statement}")`, { agent: 'eval' })
  await plur.recordTensions([tension(m, other)])
  writeFileSync(join(dir, 'candidates.yaml'), `- engram_a: ${m.id}\n  engram_b: ${other.id}\n  statement_a: ${JSON.stringify(m.statement)}\n`)
}

function leaks(clone: { dir: string; files: string[] }, text: string, id: string, read: (f: string) => string): string[] {
  return clone.files.filter(f => { const c = read(f); return c.includes(text) || c.includes(id) })
}

describe('SYN-6 side records never reveal a private memory, and machine-local memories are never synced', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore | undefined
  afterEach(() => { s?.cleanup(); s = undefined; while (cleanups.length) cleanups.pop()!() })

  const readIn = (dir: string) => (f: string): string => readFileSync(join(dir, f), 'utf8')

  it('shared repository: no episode, candidate, contradiction record or history entry carries the private memory', async () => {
    isolateGit()
    s = await tempStore({ embedder: 'off' })
    const cleared = await s.plur.learn('Team rule: release notes go in CHANGELOG.md before tagging', { scope: 'group:acme/eng', visibility: 'public' })
    const cleared2 = await s.plur.learn('Team rule: release notes are written in the past tense', { scope: 'group:acme/eng', visibility: 'public' })
    const priv = await s.plur.learn('Restart the payroll worker by hand when it hangs on my laptop', { scope: 'group:acme/eng', visibility: 'private', type: 'procedural' })

    // Side records about the private memory, written through PLUR.
    await sideRecordsAbout(s.plur, s.dir, priv, cleared)
    await s.plur.reportFailure(priv.id, 'it hung again after the restart')
    // Side records about cleared memories only (positive control).
    s.plur.capture(`Session note: applied ${cleared.id}`, { agent: 'eval' })
    await s.plur.recordTensions([tension(cleared, cleared2)])

    const remote = bareRemote(); cleanups.push(remote.cleanup)
    await s.plur.sync(remote.path, { remoteType: 'shared' })
    const clone = cloneRemote(remote.path); cleanups.push(clone.cleanup)
    const read = readIn(clone.dir)

    expect(clone.engrams.map(e => String(e.id)), 'control: the cleared team memory should reach the shared repository').toContain(cleared.id)
    expect(clone.files, 'control: the shared repository should receive the episode log').toContain('episodes.yaml')
    expect(read('episodes.yaml'), 'control: the episode about a cleared memory should reach the shared repository').toContain(cleared.id)
    expect(clone.files, 'control: the shared repository should receive the contradiction records').toContain('tensions.yaml')
    expect(read('tensions.yaml'), 'control: the contradiction record between two cleared memories should reach the shared repository').toContain(cleared2.id)

    const found = leaks(clone, priv.statement, priv.id, read)
    expect(found, `the private memory's text or id (${priv.id}) reached the shared repository in: ${found.join(', ')} (files received: ${clone.files.join(', ')})`).toEqual([])
    expect(read('episodes.yaml'), 'the failure report about the private memory reached the shared repository').not.toContain('hung again')
  })

  for (const remoteType of ['personal', 'shared'] as const) {
    it(`a memory kept to this machine reaches no ${remoteType} repository, through the memory file or a side record`, async () => {
      isolateGit()
      s = await tempStore({ embedder: 'off' })
      const local = await s.plur.learn('The dev database on this laptop listens on port 55432', { scope: 'local', visibility: 'public' })
      const control = remoteType === 'personal'
        ? await s.plur.learn('I prefer dark mode in every editor', { scope: 'global' })
        : await s.plur.learn('Team rule: every service exposes a health endpoint', { scope: 'group:acme/eng', visibility: 'public' })
      await sideRecordsAbout(s.plur, s.dir, local, control)

      const remote = bareRemote(); cleanups.push(remote.cleanup)
      await s.plur.sync(remote.path, { remoteType })
      const clone = cloneRemote(remote.path); cleanups.push(clone.cleanup)
      const read = readIn(clone.dir)

      expect(clone.engrams.map(e => String(e.id)), `control: the ${remoteType === 'personal' ? 'personal' : 'cleared team'} memory should reach the ${remoteType} repository`).toContain(control.id)
      expect(clone.engrams.map(e => String(e.id)), `the machine-local memory itself reached the ${remoteType} repository`).not.toContain(local.id)
      const found = leaks(clone, local.statement, local.id, read)
      expect(found, `the machine-local memory's text or id (${local.id}) reached the ${remoteType} repository in: ${found.join(', ')} (files received: ${clone.files.join(', ')})`).toEqual([])
    })
  }
})
