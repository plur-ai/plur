/**
 * 0.24 review, round 4: the session context appended to an injection query
 * (stored task, branch, recent turns) helps find memories, but it is not
 * what the user asked. Historical intent ("was", "old", "before", ...),
 * which lets a replaced memory back in, and the INJ-1 check of which words
 * the task names, read the task alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function open(mode: 'unified' | 'legacy' = 'unified'): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-r4-intent-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\ninjection:\n  mode: ${mode}\n`)
  return new Plur({ path: dir, autoDiscover: false })
}
const ids = (r: { directives: unknown; constraints: unknown; consider: unknown }) =>
  [r.directives, r.constraints, r.consider].flatMap(s => (Array.isArray(s) ? s : []).map((e: { id: string }) => e.id))
const text = (r: { directives: unknown; constraints: unknown; consider: unknown }) =>
  [r.directives, r.constraints, r.consider].map(s => typeof s === 'string' ? s : JSON.stringify(s)).join('\n')

describe('round 4: context words do not set the task\'s intent', () => {
  for (const mode of ['unified', 'legacy'] as const) {
    it(`${mode}: a historical word in the context does not bring a replaced memory back`, async () => {
      const plur = open(mode)
      const a = await plur.learn('Deploy zorbex with the old ftp upload script', { scope: 'global' })
      const b = await plur.learn('Deploy zorbex with the release pipeline', { scope: 'global', supersedes: [a.id] })
      const plain = await plur.injectHybrid('deploy zorbex')
      expect(text(plain)).toContain(b.id)
      expect(text(plain)).not.toContain(a.id)
      const withContext = await plur.injectHybrid('deploy zorbex', { query_context: ['the build was red this morning'] })
      expect(text(withContext)).toContain(b.id)
      expect(text(withContext)).not.toContain(a.id)
    })
  }

  it('unified: a word only in the context does not count as asked by the task (INJ-1)', async () => {
    const plur = open('unified')
    const reviews = await plur.learn('Write review summaries as bullets', { scope: 'global' })
    const incidents = await plur.learn('Write incident summaries as paragraphs', { scope: 'global' })
    // Neither variant named by the task: both are given.
    const plain = await plur.injectHybrid('write the summaries')
    expect(text(plain)).toContain(reviews.id)
    expect(text(plain)).toContain(incidents.id)
    // "incident" only in the context: the task still does not tell them apart.
    const withContext = await plur.injectHybrid('write the summaries', { query_context: ['incident on the payments queue'] })
    expect(text(withContext)).toContain(reviews.id)
    expect(text(withContext)).toContain(incidents.id)
  })
})
void ids
