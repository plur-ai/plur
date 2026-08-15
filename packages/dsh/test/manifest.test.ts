import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('dsh bundle manifest', () => {
  it('declares the bundle patch dsh plugin add relies on', () => {
    expect(pkg.name).toBe('@plur-ai/dsh')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the patch file and dist in the npm tarball', () => {
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.files).toContain('dist')
  })

  it('pins every dsh peer to one release line', () => {
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe('0.1.0-rc.6')
    }
  })

  it('mounts this package by name in the patch', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: "@plur-ai/dsh"')
  })

  it('keeps the exported VERSION in step with package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })
})

describe('README', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  // Prose wraps; assert on meaning, not on where the line breaks fall.
  const flat = readme.replace(/\s+/g, ' ').toLowerCase()

  it('documents the exact install command', () => {
    expect(readme).toContain('dsh plugin --profile web add @plur-ai/dsh')
  })

  it('discloses that memories reach the configured model provider', () => {
    expect(flat).toContain('model provider')
    expect(readme).toContain('api.deepseek.com')
  })

  it('describes scope derivation, and is honest that reads include global', () => {
    expect(readme).toContain('.plur.yaml')
    expect(flat).toContain('project:<directory name>')
    // The README used to claim "never your whole memory store". Core includes
    // global engrams in every scoped read by design, so that was false — the
    // wording must state what actually happens.
    expect(flat).not.toContain('never your whole memory store')
    expect(flat.toLowerCase()).toContain('global')
  })

  it('ships a Chinese README, matching the ecosystem convention', () => {
    expect(existsSync(join(root, 'README.zh.md'))).toBe(true)
  })

  it('is shipped in the npm tarball so npmjs.com renders it', () => {
    // `files` omits README.md, but npm always includes it — assert the Chinese
    // one explicitly, since npm does NOT include that by default.
    expect(pkg.files).toContain('README.zh.md')
  })
})
