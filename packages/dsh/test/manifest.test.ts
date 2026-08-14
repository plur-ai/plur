import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
