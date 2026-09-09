/** Invariant: acquisition cannot pass a recovery operation, and age alone
 * cannot prove that a writer on another machine has stopped. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { withLock } from '../src/sync.js'
import { withAsyncLock, DEFAULT_STALE_THRESHOLD } from '../src/store/async-lock.js'

let root: string
let target: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-lock-recovery-')); target = join(root, 'store') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe.each([
  ['sync', async (fn: () => void) => withLock(target, fn, { maxRetries: 0 })],
  ['async', async (fn: () => void) => withAsyncLock(target, async () => fn(), { maxRetries: 0 })],
] as const)('%s recovery', (_name, lock) => {
  it('cannot acquire while a recovery guard owns the pathname transition', async () => {
    writeFileSync(`${target}.lock.guard`, `${hostname()}:${process.pid}:0:0`)
    let entered = false
    await expect(lock(() => { entered = true })).rejects.toThrow(/lock/)
    expect(entered).toBe(false)
  })
  it('cannot steal an old lock belonging to a different host', async () => {
    const token = `other-${hostname()}:123:0:0`
    writeFileSync(`${target}.lock`, token)
    const old = new Date(Date.now() - DEFAULT_STALE_THRESHOLD * 3)
    utimesSync(`${target}.lock`, old, old)
    let entered = false
    await expect(lock(() => { entered = true })).rejects.toThrow(/lock/)
    expect(entered).toBe(false)
    expect(readFileSync(`${target}.lock`, 'utf8')).toBe(token)
  })
})


it('serializes independent sync and async processes while reclaiming a dead owner', async () => {
  const require = createRequire(import.meta.url)
  const cli = require.resolve('tsx/cli')
  const syncModule = fileURLToPath(new URL('../src/sync.ts', import.meta.url))
  const asyncModule = fileURLToPath(new URL('../src/store/async-lock.ts', import.meta.url))
  const script = join(root, 'contender.mts')
  writeFileSync(script, `
    import { withLock } from ${JSON.stringify(syncModule)};
    import { withAsyncLock } from ${JSON.stringify(asyncModule)};
    import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
    const [kind, target] = process.argv.slice(2);
    const sentinel = target + '.critical';
    function enter() {
      const fd = openSync(sentinel, 'wx');
      const n = Number(readFileSync(target, 'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      writeFileSync(target, String(n + 1));
      closeSync(fd); unlinkSync(sentinel);
    }
    for (let i = 0; i < 20; i++) {
      if (kind === 'sync') withLock(target, enter);
      else await withAsyncLock(target, async () => enter());
    }
  `)
  writeFileSync(target, '0')
  // Derive a confirmed exited local PID, rather than guessing a dead number.
  const run = promisify(execFile)
  const exited = await run(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  writeFileSync(`${target}.lock`, `${hostname()}:${exited.stdout}:0:0`)
  await Promise.all(['sync', 'async', 'sync', 'async'].map(kind => run(process.execPath, [cli, script, kind, target], { timeout: 30000 })))
  expect(readFileSync(target, 'utf8')).toBe('80')
}, 35000)
