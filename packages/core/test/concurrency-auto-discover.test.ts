/**
 * Constructor-time store auto-discovery opt-out (convergence Phase 2).
 *
 * `new Plur()` walks up from `process.cwd()` looking for `.plur/engrams.yaml`
 * and, on a hit, WRITES the discovered store into config.yaml. For a CLI, whose
 * cwd is the user's intent, that is the feature. For an instance shared by
 * concurrent sessions it is not: the process cwd expresses nobody's intent, and
 * the store lands in the shared config where every session sees it. Constructing
 * an object should not silently reconfigure a deployment.
 *
 * The suite has to use a NON-temp root: discovery short-circuits when
 * `paths.root` is under the OS temp dir (a long-standing test-safety guard), so
 * a `mkdtemp` root would make every assertion here vacuous.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { Plur } from '../src/index.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SCRATCH = join(HERE, '.scratch-auto-discover')

describe('Plur — constructor auto-discovery', () => {
  let root: string
  let projectDir: string
  let projectStore: string

  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
    root = join(SCRATCH, 'home', '.plur')
    projectDir = join(SCRATCH, 'workspace', 'my-project')
    projectStore = join(projectDir, '.plur', 'engrams.yaml')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(projectDir, '.plur'), { recursive: true })
    writeFileSync(projectStore, 'engrams: []\n')
    // Stop the upward walk here so it cannot escape the scratch tree.
    mkdirSync(join(SCRATCH, 'workspace', '.git'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.PLUR_AUTO_DISCOVER
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  it('discovers a project store by default (unchanged behaviour)', async () => {
    const plur = new Plur({ path: root, cwd: projectDir })
    expect(plur.autoDiscoveryEnabled()).toBe(true)
    expect((await plur.listStores()).some(s => s.path === projectStore)).toBe(true)
    // And it persisted — this is the disk side effect the opt-out exists for.
    expect(existsSync(join(root, 'config.yaml'))).toBe(true)
  })

  it('writes nothing to config when autoDiscover is false', async () => {
    const plur = new Plur({ path: root, cwd: projectDir, autoDiscover: false })
    expect(plur.autoDiscoveryEnabled()).toBe(false)
    expect((await plur.listStores()).some(s => s.path === projectStore)).toBe(false)
  })

  it('PLUR_AUTO_DISCOVER=0 disables it without touching the call site', async () => {
    process.env.PLUR_AUTO_DISCOVER = '0'
    const plur = new Plur({ path: root, cwd: projectDir })
    expect(plur.autoDiscoveryEnabled()).toBe(false)
    expect((await plur.listStores()).some(s => s.path === projectStore)).toBe(false)
  })

  it('an explicit option beats the environment variable', async () => {
    process.env.PLUR_AUTO_DISCOVER = '0'
    const plur = new Plur({ path: root, cwd: projectDir, autoDiscover: true })
    expect(plur.autoDiscoveryEnabled()).toBe(true)
    expect((await plur.listStores()).some(s => s.path === projectStore)).toBe(true)
  })

  it('resolveAutoDiscover pins the precedence rules', () => {
    delete process.env.PLUR_AUTO_DISCOVER
    expect(Plur.resolveAutoDiscover()).toBe(true)
    expect(Plur.resolveAutoDiscover(false)).toBe(false)
    process.env.PLUR_AUTO_DISCOVER = 'false'
    expect(Plur.resolveAutoDiscover()).toBe(false)
    expect(Plur.resolveAutoDiscover(true)).toBe(true)
    process.env.PLUR_AUTO_DISCOVER = '1'
    expect(Plur.resolveAutoDiscover()).toBe(true)
  })

  it('discovery stays opt-out-able when called explicitly after construction', async () => {
    const plur = new Plur({ path: root, cwd: projectDir, autoDiscover: false })
    expect((await plur.listStores()).some(s => s.path === projectStore)).toBe(false)
    // The method itself is unchanged and still works when called deliberately.
    const found = plur.autoDiscoverStores(projectDir)
    expect(found.some(f => f.path === projectStore)).toBe(true)
  })
})
