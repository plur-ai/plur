/**
 * The workspace scope reader.
 *
 * A design that resolves per-session scope is worthless if the thing it calls to
 * read the workspace is a stub. This suite exercises the real reader against a
 * real temporary filesystem — no injected fake.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkspaceScope } from '../src/workspace-scope.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-dsh-ws-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const write = (dir: string, contents: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.plur.yaml'), contents, 'utf8')
}

describe('readWorkspaceScope', () => {
  it('reads an explicit scope from .plur.yaml in the workspace root', async () => {
    write(root, 'scope: "project:acme"\n')
    expect(await readWorkspaceScope(root)).toBe('project:acme')
  })

  it('walks up to find .plur.yaml from a nested directory', async () => {
    write(root, 'scope: "project:acme"\n')
    const nested = join(root, 'packages', 'web', 'src')
    mkdirSync(nested, { recursive: true })
    expect(await readWorkspaceScope(nested)).toBe('project:acme')
  })

  it('stops at the git root rather than escaping into a parent project', async () => {
    // An outer project declares a scope; an inner git repo does not.
    write(root, 'scope: "project:outer"\n')
    const inner = join(root, 'vendor', 'inner')
    mkdirSync(join(inner, '.git'), { recursive: true })
    expect(await readWorkspaceScope(inner)).toBeUndefined()
  })

  it('prefers the nearest .plur.yaml', async () => {
    write(root, 'scope: "project:outer"\n')
    const inner = join(root, 'sub')
    write(inner, 'scope: "project:inner"\n')
    expect(await readWorkspaceScope(inner)).toBe('project:inner')
  })

  it('returns undefined when no .plur.yaml exists', async () => {
    expect(await readWorkspaceScope(root)).toBeUndefined()
  })

  it('returns undefined when .plur.yaml declares no scope', async () => {
    write(root, 'remote_url: https://example.invalid\n')
    expect(await readWorkspaceScope(root)).toBeUndefined()
  })

  it('returns undefined on malformed YAML rather than throwing', async () => {
    write(root, 'scope: [unclosed\n  : :\n')
    await expect(readWorkspaceScope(root)).resolves.toBeUndefined()
  })

  it('ignores a non-string scope', async () => {
    write(root, 'scope:\n  - project:a\n  - project:b\n')
    expect(await readWorkspaceScope(root)).toBeUndefined()
  })

  it('returns undefined for a non-existent directory', async () => {
    await expect(readWorkspaceScope(join(root, 'nope'))).resolves.toBeUndefined()
  })

  it('is bounded — does not walk the whole filesystem', async () => {
    // Deep tree, no .plur.yaml and no .git anywhere: must terminate.
    let deep = root
    for (let i = 0; i < 40; i++) deep = join(deep, `d${i}`)
    mkdirSync(deep, { recursive: true })
    await expect(readWorkspaceScope(deep)).resolves.toBeUndefined()
  })
})
