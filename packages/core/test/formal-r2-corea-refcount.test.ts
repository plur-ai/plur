/**
 * core-index#8 (round 2, R2-CoreA): reference-counted retirement (#107) must be
 * symmetric across stores.
 *
 * forget() DECREMENTS write_count in a writable secondary (path) store — the
 * audit iter-1 fix says so explicitly ("breaks the #107 contract for cross-store
 * engrams"), and cross-scope recurrence persists its increment there. But a
 * same-scope duplicate write whose hit lives in a secondary store was counted
 * in memory only, so two writers → one forget → retired: the second writer's
 * reference vanished.
 *
 * Model: spec/formal/PlurSpec/R2CoreA.lean §3. No network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const SCOPE = 'group:acme/shared'
const STATEMENT = 'Team convention: release notes go in CHANGELOG.md'

describe('core-index#8 — a duplicate write into a secondary store is counted on disk', () => {
  let dir: string
  let storePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-ref-'))
    storePath = join(dir, 'team-engrams.yaml')
    writeFileSync(storePath, yaml.dump({ engrams: [] }))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ path: storePath, scope: SCOPE, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const seed = async (readonly = false) => {
    // Put the engram into the team store the way a teammate's process would.
    const other = new Plur({ path: join(dir, 'teammate') })
    const e = await other.learn(STATEMENT, { scope: SCOPE })
    const row = { ...(await other.getById(e.id)) }
    writeFileSync(storePath, yaml.dump({ engrams: [row] }))
    if (readonly) {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        stores: [{ path: storePath, scope: SCOPE, readonly: true }], index: false,
      }))
    }
    return row
  }
  const onDisk = () => (yaml.load(readFileSync(storePath, 'utf8')) as any).engrams[0]

  it('the increment is persisted to the secondary store', async () => {
    await seed()
    const plur = new Plur({ path: dir })
    const hit = await plur.learn(STATEMENT, { scope: SCOPE })
    expect(hit.write_count).toBe(2)
    expect(onDisk().write_count).toBe(2)
  })

  it('two writers, one forget: the engram stays active with one reference', async () => {
    await seed()
    const plur = new Plur({ path: dir })
    const hit = await plur.learn(STATEMENT, { scope: SCOPE })
    await plur.forget(hit.id)
    expect(onDisk().status).toBe('active')
    expect(onDisk().write_count).toBe(1)
    await plur.forget(hit.id)
    expect(onDisk().status).toBe('retired')
  })

  it('a readonly secondary store is never written', async () => {
    await seed(true)
    const before = readFileSync(storePath, 'utf8')
    const plur = new Plur({ path: dir })
    await plur.learn(STATEMENT, { scope: SCOPE })
    expect(readFileSync(storePath, 'utf8')).toBe(before)
  })
})
