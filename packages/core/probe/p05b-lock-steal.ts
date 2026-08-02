/**
 * P05b — the stale-lock steal itself.
 *
 * Holder holds for 20 s. Thief starts at t+10.5 s, so its FIRST EEXIST check
 * sees a lock file older than staleThreshold (10 s) and deletes it. Both then
 * run their critical sections at the same time, and the holder's `finally`
 * unlinks whatever lock file is present — the thief's.
 */
import { withAsyncLock } from '../src/store/async-lock.js'
import { fork } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const self = fileURLToPath(import.meta.url)
const target = process.argv[3]

if (process.argv[2] === 'holder') {
  await withAsyncLock(target, async () => {
    fs.writeFileSync(target + '.holder-in', String(Date.now()))
    await new Promise(r => setTimeout(r, 20_000))
    fs.appendFileSync(target + '.log', `holder leaving, lock exists=${fs.existsSync(target + '.lock')} owner=${fs.existsSync(target + '.lock') ? fs.readFileSync(target + '.lock', 'utf8') : '-'}\n`)
  })
  fs.appendFileSync(target + '.log', `holder released; lock file now exists=${fs.existsSync(target + '.lock')}\n`)
  process.exit(0)
} else if (process.argv[2] === 'thief') {
  await withAsyncLock(target, async () => {
    const overlapping = fs.existsSync(target + '.holder-in')
      && Date.now() - Number(fs.readFileSync(target + '.holder-in', 'utf8')) < 20_000
    fs.appendFileSync(target + '.log', `THIEF ENTERED while holder still inside=${overlapping} (pid ${process.pid})\n`)
    await new Promise(r => setTimeout(r, 12_000))
    fs.appendFileSync(target + '.log', `thief leaving, my lock still present=${fs.existsSync(target + '.lock')}\n`)
  })
  process.exit(0)
} else {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p05b-'))
  const target = join(root, 'engrams.yaml')
  fs.writeFileSync(target, 'engrams: []\n')
  const holder = fork(self, ['holder', target], { stdio: 'inherit' })
  await new Promise(r => setTimeout(r, 10_500))
  const thief = fork(self, ['thief', target], { stdio: 'inherit' })
  await new Promise<void>(res => { let n = 0; const d = () => { if (++n === 2) res() }; holder.on('exit', d); thief.on('exit', d) })
  console.log(fs.existsSync(target + '.log') ? fs.readFileSync(target + '.log', 'utf8') : '(no log)')
  fs.rmSync(root, { recursive: true, force: true })
}
