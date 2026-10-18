import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, lstatSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { runInNewContext } from 'vm'

// Exercise the actual standalone probe's checker without installing editor CLIs.
// Deliberate writes outside PLUR_PATH must be detected as off-folder violations.
it('detects transient session writes and persistent store writes independently (#1605)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plur-editor-state-'))
  try {
    const env = { PLUR_PATH: join(dir, 'store'), TMPDIR: join(dir, 'tmp') }
    Object.values(env).forEach(p => mkdirSync(p))
    const source = readFileSync(resolve(__dirname, '../../../scripts/windows-editors-probe.mjs'), 'utf8')
    const code = source.slice(source.indexOf('function storeState()'), source.indexOf('const gitBash'))
    const { storeState, diffState } = runInNewContext(code + ';({storeState, diffState})', {
      env, join, readdirSync, statSync, lstatSync, existsSync, readFileSync,
      tryRead: (fn: () => unknown) => { try { return fn() } catch { return undefined } },
    })
    const before = storeState()
    const sentinel = join(env.TMPDIR, 'plur-session-off-fixture')
    writeFileSync(sentinel, '')
    expect(diffState(before, storeState()).length, 'off hook silently wrote a session marker').toBeGreaterThan(0)
    rmSync(sentinel)
    expect(diffState(before, storeState())).toEqual([])
    writeFileSync(join(env.PLUR_PATH, 'engrams.yaml'), 'unexpected')
    expect(diffState(before, storeState()).length).toBeGreaterThan(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
