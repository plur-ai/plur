/**
 * Test preload (`node --import <this> cli.js ...`) for the store lock's
 * acquisition window (#1313 review).
 *
 * Core takes `engrams.yaml.lock` with `writeFile(lock, token, { flag: O_EXCL })`:
 * an O_EXCL create (an EMPTY file), then the token write. The create is an
 * async fs call run off the main thread, so a hook that checks "is there a
 * lock of mine?" and then calls process.exit() can still lose the race: the
 * create was already on its way and lands after the check. An empty lock is
 * left that core cannot attribute to anyone, so it waits out its 60s stale
 * threshold.
 *
 * PLUR_TEST_LOCK_PLAN is a comma list, one entry per acquisition in order:
 *   slow:<ms>  create at once, hold the lock EMPTY for <ms>, then write the token
 *   late:<ms>  the create lands <ms> later, done by a detached process so it
 *              happens whether or not this process is still alive; the caller's
 *              promise resolves only once it has landed
 *   -          untouched
 * Nothing in production reads the env var; without this preload it is inert.
 */
import fsp from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const PLAN = String(process.env.PLUR_TEST_LOCK_PLAN ?? '').split(',').filter(s => s.trim() !== '')
let acquisitions = 0
const realWriteFile = fsp.writeFile
const sleep = ms => new Promise(r => setTimeout(r, ms))

fsp.writeFile = async function planLockWriteFile(file, data, options) {
  const flag = options && typeof options === 'object' ? options.flag : undefined
  if (PLAN.length > 0 && typeof file === 'string' && file.endsWith('engrams.yaml.lock')
    && typeof flag === 'number' && (flag & constants.O_EXCL)) {
    const step = PLAN[acquisitions++] ?? '-'
    const [kind, msRaw] = step.split(':')
    const ms = Number(msRaw) || 0
    if (kind === 'slow') {
      const handle = await fsp.open(file, flag) // throws EEXIST exactly as before
      try { await sleep(ms); await handle.writeFile(data) } finally { await handle.close() }
      return
    }
    if (kind === 'late') {
      if (existsSync(file)) { const e = new Error(`EEXIST: ${file}`); e.code = 'EEXIST'; throw e }
      const js = `setTimeout(()=>{try{require('fs').writeFileSync(${JSON.stringify(file)},'',{flag:'wx'})}catch{}},${ms})`
      spawn(process.execPath, ['-e', js], { detached: true, stdio: 'ignore' }).unref()
      while (!existsSync(file)) await sleep(10)
      const handle = await fsp.open(file, 'r+')
      try { await handle.writeFile(data) } finally { await handle.close() }
      return
    }
  }
  return realWriteFile.call(this, file, data, options)
}
syncBuiltinESMExports()
