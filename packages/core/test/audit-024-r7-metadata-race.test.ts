/**
 * 0.24 review round 7 (part of #1946): persistScopeMetadata reads the stores
 * list before it takes the config lock. When another process removes an
 * entry in between, the metadata write would put the removed entry back,
 * which the store-registration rule refuses for a metadata write. That is
 * not an error for its callers (session start, discovery, login): the
 * metadata write is skipped, logged, and the removal stands.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const URL_ = 'https://a.example.test'
const TEAM = 'group:x/team'
const GONE = 'group:x/gone'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('round 7: a metadata write racing a removal', () => {
  it('skips the write instead of throwing, and the removed entry stays removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-r7-meta-'))
    dirs.push(dir)
    const file = join(dir, 'config.yaml')
    const both = [{ url: URL_, token: 't', scope: TEAM }, { url: URL_, token: 't', scope: GONE }]
    writeFileSync(file, yaml.dump({ embeddings: { enabled: false }, index: false, stores: both }))
    const plur = new Plur({ path: dir, autoDiscover: false }) as unknown as {
      persistStores(s: unknown[], o: unknown): void
      persistScopeMetadata(d: unknown[]): void
    }
    const orig = plur.persistStores.bind(plur)
    // Another process removes GONE after the stores were read, before the write.
    plur.persistStores = (s, o) => {
      writeFileSync(file, yaml.dump({ embeddings: { enabled: false }, index: false, stores: [both[0]] }))
      return orig(s, o)
    }
    expect(() => plur.persistScopeMetadata([{
      url: URL_, ok: true, authorized: [TEAM, GONE], registered: [TEAM, GONE], unregistered: [],
      metadata: [{ scope: TEAM, covers: ['deploys'], description: 'Team memory' }],
    }])).not.toThrow()
    expect(readFileSync(file, 'utf8')).not.toContain(GONE)
  })
})
