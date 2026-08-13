/**
 * Release blockers from the 2026-08-03 adversarial audit of the fix diff (#821).
 *
 * These three were introduced BY the fixes for the earlier audits, which is why
 * three prior audits and 3,800 passing tests did not surface them.
 *
 *   5. the shrink guard's byte pre-check let a record-count shrink through
 *   6. the refuse-on-corrupt loaders took down `status()` — and `session_start`
 *   7. atomic replacement dropped 0600 from credential-bearing config files
 *
 * Finding 5's regressions live in `store-corruption-guard.test.ts` beside the
 * guard's other tests. 6 and 7 are here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { atomicWrite, CONFIG_FILE_MODE } from '../src/sync.js'

const isPosix = process.platform !== 'win32'

describe('#821 finding 6 — status() reports broken artifacts instead of dying', () => {
  let root: string

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-821-status-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function ready(): Promise<Plur> {
    const plur = new Plur({ path: root })
    await plur.ready()
    await plur.learn('a benign engram so the corpus is not empty', { scope: 'global' })
    return plur
  }

  /**
   * The one that mattered most: MCP `session_start` awaits `status()`, so a
   * truncated episodes file meant NO SESSION COULD START. The first fix for
   * this class covered only the pack registry.
   */
  it('survives a corrupt episodes store', async () => {
    const plur = await ready()
    writeFileSync(join(root, 'episodes.yaml'), 'not: a list\n  broken: "')

    const status = await plur.status()
    expect(status.store_errors?.episodes).toBeDefined()
    expect(status.episode_count).toBe(0)
    // The rest of the report still works — that is the whole point.
    expect(status.engram_count).toBeGreaterThan(0)
  })

  it('survives a corrupt tensions store', async () => {
    const plur = await ready()
    writeFileSync(join(root, 'tensions.yaml'), 'tensions: {not: a list}\n')

    const status = await plur.status()
    expect(status.store_errors?.tensions).toBeDefined()
    expect(status.engram_count).toBeGreaterThan(0)
  })

  it('survives a corrupt pack registry, and still sets the legacy alias', async () => {
    const plur = await ready()
    mkdirSync(join(root, 'packs'), { recursive: true })
    writeFileSync(join(root, 'packs', 'registry.yaml'), 'packs:\n - name: a\n bad: "')

    const status = await plur.status()
    expect(status.store_errors?.packs).toBeDefined()
    expect(status.pack_registry_error).toBe(status.store_errors?.packs)
  })

  it('survives a corrupt corpus — the loudest possible "what is wrong?"', async () => {
    const plur = await ready()
    writeFileSync(join(root, 'engrams.yaml'), 'engrams:\n')

    const status = await plur.status()
    expect(status.store_errors?.engrams).toBeDefined()
    expect(status.engram_count).toBe(0)
  })

  it('reports EVERY broken artifact, not just the first', async () => {
    const plur = await ready()
    writeFileSync(join(root, 'episodes.yaml'), 'oops: "')
    writeFileSync(join(root, 'tensions.yaml'), 'also: {bad: ')

    const status = await plur.status()
    // One bad file must not mask another — an operator fixing them one at a
    // time round-trips once per file otherwise.
    expect(Object.keys(status.store_errors ?? {}).sort()).toEqual(['episodes', 'tensions'])
  })

  it('sets no store_errors when everything is healthy', async () => {
    const plur = await ready()
    const status = await plur.status()
    expect(status.store_errors).toBeUndefined()
    expect(status.pack_registry_error).toBeUndefined()
  })
})

describe.skipIf(!isPosix)('#821 finding 7 — atomicWrite preserves credential file permissions', () => {
  let root: string

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-821-mode-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const modeOf = (p: string) => statSync(p).mode & 0o777

  it('keeps 0600 across a replace', () => {
    const f = join(root, 'config.yaml')
    writeFileSync(f, 'token: secret\n')
    chmodSync(f, 0o600)

    atomicWrite(f, 'token: secret\nstores: []\n')

    // Replace-by-rename creates a new inode, so without explicit preservation
    // this became 0644 under the common umask 022 — world-readable credentials.
    expect(modeOf(f)).toBe(0o600)
  })

  it('never LOOSENS a mode the operator tightened, even when asked to', () => {
    const f = join(root, 'config.yaml')
    writeFileSync(f, 'token: secret\n')
    chmodSync(f, 0o400) // stricter than CONFIG_FILE_MODE

    atomicWrite(f, 'token: rotated\n', { mode: CONFIG_FILE_MODE })

    expect(modeOf(f)).toBe(0o400)
  })

  it('creates a new credential file at the requested mode', () => {
    const f = join(root, 'fresh-config.yaml')
    atomicWrite(f, 'token: secret\n', { mode: CONFIG_FILE_MODE })
    expect(modeOf(f)).toBe(0o600)
  })

  it('leaves ordinary store files at the platform default', () => {
    const f = join(root, 'engrams.yaml')
    atomicWrite(f, 'engrams: []\n')
    // No mode requested and nothing to preserve — unchanged behaviour.
    expect(modeOf(f) & 0o600).toBe(0o600)
  })

  it('keeps config.yaml owner-only across a real config write', async () => {
    const plur = new Plur({ path: root })
    await plur.ready()
    const cfg = join(root, 'config.yaml')
    writeFileSync(cfg, yaml.dump({ auto_learn: true }))
    chmodSync(cfg, 0o600)

    // A config write through the engine's own path (schema version stamp).
    const { setSchemaVersion } = await import('../src/migrations/runner.js')
    setSchemaVersion(cfg, 4)

    expect(modeOf(cfg)).toBe(0o600)
    expect((yaml.load(readFileSync(cfg, 'utf8')) as any).schema_version).toBe(4)
  })
})
