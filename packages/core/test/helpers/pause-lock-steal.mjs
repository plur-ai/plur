/**
 * Test preload (`node --import <this> ...`): pause a lock TAKEOVER at its two
 * racy points, so a multi-process race is reproduced deterministically instead
 * of 1 run in N (#1354).
 *
 *   1. just before the claim `rename(engrams.yaml.lock -> *.steal.*)`: writes
 *      `paused-rename` into PLUR_TEST_PAUSE_DIR and waits for `go-rename`;
 *   2. just before a claimed lock is put back, `link(*.steal.* -> engrams.yaml.lock)`:
 *      writes `paused-link` and waits for `go-link`.
 *
 * Each pause fires once. Takeovers of the takeover guard itself are not paused.
 * Nothing in production reads the env var; without this preload it is inert.
 */
import fsp from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const dir = process.env.PLUR_TEST_PAUSE_DIR
const until = async (f) => { while (!existsSync(f)) await new Promise(r => setTimeout(r, 10)) }
const realRename = fsp.rename
const realLink = fsp.link
let renamePaused = false
let linkPaused = false

fsp.rename = async function pausedRename(src, dest) {
  if (dir && !renamePaused && String(src).endsWith('engrams.yaml.lock') && String(dest).includes('.steal.')) {
    renamePaused = true
    writeFileSync(join(dir, 'paused-rename'), '')
    await until(join(dir, 'go-rename'))
  }
  return realRename.call(this, src, dest)
}
fsp.link = async function pausedLink(src, dest) {
  if (dir && !linkPaused && String(src).includes('.steal.') && String(dest).endsWith('engrams.yaml.lock')) {
    linkPaused = true
    writeFileSync(join(dir, 'paused-link'), '')
    await until(join(dir, 'go-link'))
  }
  return realLink.call(this, src, dest)
}
syncBuiltinESMExports()
