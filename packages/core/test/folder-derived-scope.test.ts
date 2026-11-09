import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveFolderPolicy } from '../src/folders.js'

/**
 * PLUR_FOLDER_SCOPE=project, set by the Claude directory plugin: a folder that
 * is on and has no scope of its own gets one named after its repository, so one
 * project's notes are not injected into another. Measured before this: a
 * project's convention reached every other project in 15 of 15 trials.
 */
describe('PLUR_FOLDER_SCOPE=project', () => {
  let base = ''
  const before = process.env.PLUR_FOLDER_SCOPE
  afterEach(() => {
    if (before === undefined) delete process.env.PLUR_FOLDER_SCOPE
    else process.env.PLUR_FOLDER_SCOPE = before
    if (base) rmSync(base, { recursive: true, force: true })
  })

  function setup(entry: string, name = 'alpha-app') {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-derived-')))
    const root = join(base, 'store')
    const repo = join(base, 'home', name)
    mkdirSync(root, { recursive: true })
    mkdirSync(join(repo, '.git', 'x'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${repo}"\n${entry}`)
    return { root, repo, home: join(base, 'home') }
  }

  it('changes nothing when the variable is unset', () => {
    delete process.env.PLUR_FOLDER_SCOPE
    const { root, repo, home } = setup('    plur: on\n')
    expect(resolveFolderPolicy(repo, { root, home }).scope).toBeUndefined()
  })

  it('names the scope after the repository', () => {
    process.env.PLUR_FOLDER_SCOPE = 'project'
    const { root, repo, home } = setup('    plur: on\n')
    const policy = resolveFolderPolicy(repo, { root, home })
    expect(policy.mode).toBe('on')
    expect(policy.scope).toBe('project:alpha-app')
  })

  it('uses the same scope from a subfolder of the repository', () => {
    process.env.PLUR_FOLDER_SCOPE = 'project'
    const { root, repo, home } = setup('    plur: on\n')
    expect(resolveFolderPolicy(join(repo, 'src'), { root, home }).scope).toBe('project:alpha-app')
  })

  it('keeps a scope the folder already has', () => {
    process.env.PLUR_FOLDER_SCOPE = 'project'
    const { root, repo, home } = setup('    plur: on\n    scope: project:chosen\n')
    expect(resolveFolderPolicy(repo, { root, home }).scope).toBe('project:chosen')
  })

  it('does not turn on a folder that is off or undecided', () => {
    process.env.PLUR_FOLDER_SCOPE = 'project'
    const off = setup('    plur: off\n')
    expect(resolveFolderPolicy(off.repo, { root: off.root, home: off.home }).mode).toBe('off')
    expect(resolveFolderPolicy(off.repo, { root: off.root, home: off.home }).scope).toBeUndefined()
    rmSync(base, { recursive: true, force: true })
    const ask = setup('    plur: ask\n')
    expect(resolveFolderPolicy(ask.repo, { root: ask.root, home: ask.home }).scope).toBeUndefined()
  })

  it('replaces characters a scope cannot hold', () => {
    process.env.PLUR_FOLDER_SCOPE = 'project'
    const { root, repo, home } = setup('    plur: on\n', 'my app (old)')
    expect(resolveFolderPolicy(repo, { root, home }).scope).toBe('project:my-app-old')
  })
})
