/**
 * P02 — episodes.yaml / tensions.yaml sibling concurrency.
 *
 * captureEpisode() is load → push → atomicWrite with NO lock of any kind.
 * Two processes capturing at the same time should lose episodes; the fixed
 * `<path>.tmp` name means they can also rename each other's partial file
 * into place.
 *
 * Usage:
 *   tsx p02-episodes-concurrency.ts child <root> <tag> <n>
 *   tsx p02-episodes-concurrency.ts            (parent — spawns children)
 */
import { captureEpisode, queryTimeline } from '../src/episodes.js'
import { fork } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  const [, , , root, tag, nStr] = process.argv
  const path = join(root, 'episodes.yaml')
  const n = Number(nStr)
  // A fat payload widens the write window (real episodes carry session summaries).
  const filler = 'x'.repeat(4000)
  for (let i = 0; i < n; i++) captureEpisode(path, `${tag}-${i} ${filler}`, { agent: tag })
  process.exit(0)
} else {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p02-'))
  const path = join(root, 'episodes.yaml')
  const PROCS = 4
  const PER = 25
  const children = Array.from({ length: PROCS }, (_, i) =>
    new Promise<void>(res => fork(self, ['child', root, `w${i}`, String(PER)], { stdio: 'inherit' }).on('exit', () => res())),
  )
  await Promise.all(children)
  let episodes: unknown[] = []
  let parseErr = ''
  try { episodes = queryTimeline(path) } catch (e) { parseErr = (e as Error).message }
  const expected = PROCS * PER
  console.log(`episodes.yaml: expected ${expected}, found ${episodes.length}${parseErr ? ` (parse error: ${parseErr})` : ''}`)
  console.log(`LOST ${expected - episodes.length} episodes (${(((expected - episodes.length) / expected) * 100).toFixed(0)}%)`)
  console.log('leftover tmp files:', fs.readdirSync(root).filter(f => f.endsWith('.tmp')))
  fs.rmSync(root, { recursive: true, force: true })
}
