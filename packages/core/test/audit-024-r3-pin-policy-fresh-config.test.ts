/**
 * 0.24 review, round 3: a pin decision reads the current config.yaml. When
 * the owner sets `pinning.agents` to `deny` or `request` while a process is
 * running (a long-lived MCP server), the very next agent pin follows it:
 * setPinned, learn with pinned:true and store registration do not decide
 * from the config loaded before the edit.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const BASE = 'embeddings:\n  enabled: false\nindex: false\n'

function setup(): { dir: string; plur: Plur } {
  const dir = mkdtempSync(join(tmpdir(), 'plur-r3-fresh-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), BASE)
  return { dir, plur: new Plur({ path: dir, autoDiscover: false, actor: 'agent' }) }
}

/** The owner's edit, with a modification time the process cannot mistake for the old file's. */
function ownerSets(dir: string, agents: 'request' | 'deny'): void {
  const file = join(dir, 'config.yaml')
  const before = statSync(file).mtimeMs
  writeFileSync(file, `${BASE}pinning:\n  agents: ${agents}\n`)
  const later = new Date(before + 5000)
  utimesSync(file, later, later)
}

describe('round 3: the pin policy follows config.yaml edited mid-process', () => {
  it('deny: the next setPinned by an agent is refused', async () => {
    const { dir, plur } = setup()
    const e = await plur.learn('Use tabs for indentation in this repo', { scope: 'global' })
    await plur.recall('indentation')
    ownerSets(dir, 'deny')
    await expect(plur.setPinned(e.id, true)).rejects.toMatchObject({ code: 'pin_denied' })
    expect((await plur.getById(e.id))?.pinned).not.toBe(true)
  })

  it('deny: the next learn with pinned:true by an agent is refused', async () => {
    const { dir, plur } = setup()
    await plur.learn('Warm-up memory before the edit', { scope: 'global' })
    ownerSets(dir, 'deny')
    await expect(plur.learn('Always run the linter', { pinned: true, scope: 'global', actor: 'agent' }))
      .rejects.toMatchObject({ code: 'pin_denied' })
  })

  it('request: the next learn with pinned:true is stored unpinned as a request', async () => {
    const { dir, plur } = setup()
    await plur.learn('Warm-up memory before the edit', { scope: 'global' })
    ownerSets(dir, 'request')
    const e = await plur.learn('Always run the formatter', { pinned: true, scope: 'global', actor: 'agent' })
    expect(e.pinned).not.toBe(true)
    expect(plur.pinPolicyFor('agent')).toBe('request')
  })

  it('deny: the next store registration by an agent is refused', async () => {
    const { dir, plur } = setup()
    const other = mkdtempSync(join(tmpdir(), 'plur-r3-fresh-src-'))
    dirs.push(other)
    writeFileSync(join(other, 'engrams.yaml'), '[]\n')
    ownerSets(dir, 'deny')
    expect(() => plur.addStore(join(other, 'engrams.yaml'), 'project:demo')).toThrow(expect.objectContaining({ code: 'pin_denied' }))
  })
})
