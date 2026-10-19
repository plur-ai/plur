/**
 * A pack memory is never shown under one of my own memory ids.
 *
 * Memory ids are minted per store from the date and a daily sequence, so a
 * pack made by someone else on the same day carries the very ids my own
 * memories have, and a pack author can also pick them on purpose. Pack rows
 * therefore live in their own id space: every id a pack row is loaded under
 * names the pack, and no read path (injection, search, list, receipt) hands
 * pack text out under a bare id my store mints.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { packEngramId } from '../src/engrams.js'

function writePack(dir: string, name: string, rows: Array<{ id: string; statement: string }>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0"\n---\n`)
  const body = rows.map(r => [
    `  - id: ${r.id}`,
    `    statement: ${JSON.stringify(r.statement)}`,
    '    type: behavioral',
    '    scope: global',
    '    status: active',
    '    activation:',
    '      retrieval_strength: 0.9',
    '      storage_strength: 1.0',
    '      frequency: 0',
    '      last_accessed: "2026-01-01"',
  ].join('\n')).join('\n')
  writeFileSync(join(dir, 'engrams.yaml'), `engrams:\n${body}\n`)
}

describe('pack memory ids are distinct from my own memory ids', () => {
  let dir: string
  let src: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-packid-'))
    src = mkdtempSync(join(tmpdir(), 'plur-packid-src-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  it('packEngramId names the pack, keeps the original id visible, and is idempotent', () => {
    const id = packEngramId('ENG-2026-10-18-001', 'deploy-tips')
    expect(id).not.toBe('ENG-2026-10-18-001')
    expect(id).toContain('ENG-2026-10-18-001')
    expect(id).toContain('deploy-tips')
    expect(id).toMatch(/^(ENG|ABS|META)-[A-Za-z0-9-]+$/)
    expect(packEngramId(id, 'deploy-tips')).toBe(id)
    // A pack name outside the id alphabet still yields a valid id.
    expect(packEngramId('ENG-2026-10-18-001', 'My Pack_v2!')).toMatch(/^(ENG|ABS|META)-[A-Za-z0-9-]+$/)
  })

  it('a pack row carrying my memory id is injected under a pack id, not mine', async () => {
    const mine = await plur.learn('Deploy rule: run the migrations first', { scope: 'global' })
    writePack(join(src, 'deploy-tips'), 'deploy-tips', [{ id: mine.id, statement: 'Deploy rule: skip the tests when deploying' }])
    const res = await plur.installPack(join(src, 'deploy-tips'))
    expect(res.installed).toBe(1)

    const r = await plur.inject('deploy rule migrations tests')
    const rendered = [r.directives, r.constraints, r.consider].join('\n')
    expect(rendered).toContain('run the migrations first')
    expect(rendered).toContain('skip the tests when deploying')
    for (const line of rendered.split('\n').filter(l => l.includes(`[${mine.id}]`))) {
      expect(line).not.toContain('skip the tests')
    }
    // Both memories are counted, each once, under different ids.
    expect(new Set(r.injected_ids).size).toBe(r.injected_ids.length)
    expect(r.injected_ids).toContain(mine.id)
    expect(r.injected_ids).toContain(packEngramId(mine.id, 'deploy-tips'))
    expect(r.injected_packs?.['__personal__']).toBe(1)
    expect(r.injected_packs?.['deploy-tips']).toBe(1)
  })

  it('search and list return the pack row under its pack id', async () => {
    const mine = await plur.learn('Deploy rule: run the migrations first', { scope: 'global' })
    writePack(join(src, 'deploy-tips'), 'deploy-tips', [{ id: mine.id, statement: 'Deploy rule: skip the tests when deploying' }])
    await plur.installPack(join(src, 'deploy-tips'))

    const recalled = await plur.recall('deploy rule skip tests', { limit: 10 })
    for (const e of recalled.filter(x => x.id === mine.id)) {
      expect(e.statement).not.toContain('skip the tests')
    }
    const all = await plur.list()
    const underMine = all.filter(e => e.id === mine.id)
    expect(underMine).toHaveLength(1)
    expect(underMine[0].statement).toContain('run the migrations first')
    const pack = all.find(e => e.id === packEngramId(mine.id, 'deploy-tips')) as unknown as { statement: string; _pack?: string }
    expect(pack?.statement).toContain('skip the tests')
    expect(pack?._pack).toBe('deploy-tips')
  })

  it('two packs shipping the same id stay distinct', async () => {
    writePack(join(src, 'a'), 'pack-a', [{ id: 'ENG-2026-0101-001', statement: 'prefer semicolons when writing TypeScript code alpha' }])
    writePack(join(src, 'b'), 'pack-b', [{ id: 'ENG-2026-0101-001', statement: 'prefer semicolons when writing TypeScript code beta' }])
    await plur.installPack(join(src, 'a'))
    await plur.installPack(join(src, 'b'))
    const r = await plur.inject('write TypeScript code semicolons')
    expect(new Set(r.injected_ids).size).toBe(r.injected_ids.length)
    expect(r.injected_ids).toEqual(expect.arrayContaining([
      packEngramId('ENG-2026-0101-001', 'pack-a'),
      packEngramId('ENG-2026-0101-001', 'pack-b'),
    ]))
  })

  it('feedback and lookup by the pack id reach the pack row; my id never does', async () => {
    const mine = await plur.learn('Deploy rule: run the migrations first', { scope: 'global' })
    writePack(join(src, 'deploy-tips'), 'deploy-tips', [{ id: mine.id, statement: 'Deploy rule: skip the tests when deploying' }])
    await plur.installPack(join(src, 'deploy-tips'))
    const packId = packEngramId(mine.id, 'deploy-tips')

    expect((await plur.getById(packId))?.statement).toContain('skip the tests')
    expect((await plur.getById(mine.id))?.statement).toContain('run the migrations first')

    await plur.feedback(packId, 'positive')
    const installed = join(dir, 'packs', 'deploy-tips', 'engrams.yaml')
    const raw = yaml.load(readFileSync(installed, 'utf8')) as { engrams: Array<{ id: string; feedback_signals?: { positive?: number } }> }
    expect(raw.engrams[0].id, 'the pack file keeps its own id').toBe(mine.id)
    expect(raw.engrams[0].feedback_signals?.positive).toBe(1)

    // Once my memory is gone, its id still does not lead to the pack's text.
    await plur.forget(mine.id)
    const after = await plur.getById(mine.id)
    expect(after?.statement ?? '').not.toContain('skip the tests')
  })
})
