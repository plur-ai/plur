/**
 * Security audit 2026-11-06: the dsh plugin ignored the folder map.
 *
 * A folder set `plur: off` in folders.yaml means PLUR does nothing there, and
 * `remote-only` means no personal memory is read or written there. The plugin
 * built one unbound engine and never resolved the map, so in an off folder it
 * still injected and recalled personal engrams, stored plur_learn writes and
 * auto-learned corrections; in a remote-only folder it wrote personal rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'
import { apply } from '../src/index.js'
import { createEngine } from '../src/engine.js'
import { cfg } from './helpers/config.js'
import { askedEvents } from './helpers/agent.js'

function makeCtx() {
  const listeners = new Map<string, Function[]>()
  const sections: any[] = []
  const tools: any[] = []
  const ctx: any = {
    on: (event: string, fn: Function) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => {} },
    systemPrompt: { section: (s: any) => { sections.push(s); return () => {} } },
    tools: { register: (d: any) => { tools.push(d); return () => {} } },
    logger: { warn: vi.fn(), info: vi.fn() },
    effect: () => () => {},
    inject: () => ({ then: (r: any) => r(undefined) }),
  }
  const fire = (event: string, ...args: any[]) => Promise.all((listeners.get(event) ?? []).map(fn => fn(...args)))
  return { ctx, sections, tools, fire }
}

const settle = (ms = 300) => new Promise(r => setTimeout(r, ms))

describe('dsh follows the folder map (security audit 2026-11-06)', () => {
  let root: string
  let store: string
  let offDir: string
  let roDir: string
  let onDir: string

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-dsh-folders-')))
    store = join(root, 'store')
    offDir = join(root, 'w', 'offdir')
    roDir = join(root, 'w', 'rodir')
    onDir = join(root, 'w', 'ondir')
    for (const d of [store, offDir, roDir, onDir]) mkdirSync(d, { recursive: true })
    writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    writeFileSync(join(store, 'folders.yaml'), [
      'version: 1',
      'folders:',
      `  - path: ${offDir}`,
      '    plur: off',
      `  - path: ${roDir}`,
      '    plur: remote-only',
      '    scope: group:acme/eng',
      `  - path: ${onDir}`,
      '    plur: on',
      '',
    ].join('\n'))
    await new Plur({ path: store }).learn('quokka personal fact: the deploy key lives in the vault', { scope: 'global' })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const statements = async () =>
    (await new Plur({ path: store }).list() as Array<{ statement: string }>).map(e => e.statement)

  function mount() {
    const h = makeCtx()
    apply(h.ctx, cfg({ path: store }), createEngine(cfg({ path: store }), () => import('@plur-ai/core'), () => {}))
    const run = async (name: string, args: unknown, cwd: string) => {
      const t = h.tools.find(x => x.name === name)
      const agent = { id: `a-${cwd}`, session: { header: { cwd } } }
      const v = await t.execute(args, { agent, signal: new AbortController().signal })
      return t.output.render(args, v).map((b: any) => b.text).join('\n') as string
    }
    const inject = async (cwd: string) => {
      const agent = { id: `inj-${cwd}`, session: { events: askedEvents('quokka personal fact deploy key'), header: { cwd } } }
      await h.fire('agent/pre-step', { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [] }))
      await settle()
      return h.sections[0].text({ agent }) as string
    }
    return { ...h, run, inject }
  }

  it('off: tools answer that PLUR is off and read or write nothing', async () => {
    const h = mount()
    const learned = await h.run('plur_learn', { statement: 'OFF tool write should not land' }, offDir)
    expect(learned).toMatch(/PLUR is off/)
    const recalled = await h.run('plur_recall', { query: 'quokka personal fact' }, offDir)
    expect(recalled).toMatch(/PLUR is off/)
    expect(recalled).not.toContain('quokka')
    expect(await statements()).not.toContain('OFF tool write should not land')
  })

  it('off: no injection and no auto-learn', async () => {
    const h = mount()
    expect(await h.inject(offDir)).not.toContain('quokka')
    await h.fire('session/event', { id: 's-off', header: { cwd: offDir } }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'No, use pnpm not npm in this repo.' }] },
    })
    await settle()
    expect((await statements()).some(s => /pnpm/.test(s))).toBe(false)
  })

  it('remote-only: a personal write is refused and personal memory is not read', async () => {
    const h = mount()
    const learned = await h.run('plur_learn', { statement: 'RO tool write should not land locally' }, roDir)
    expect(learned).not.toMatch(/^Stored\./)
    expect(await statements()).not.toContain('RO tool write should not land locally')
    expect(await h.run('plur_recall', { query: 'quokka personal fact' }, roDir)).not.toContain('quokka')
  })

  it('on: memory still works (positive control)', async () => {
    const h = mount()
    expect(await h.run('plur_learn', { statement: 'ON tool write lands' }, onDir)).toMatch(/^Stored\./)
    expect(await statements()).toContain('ON tool write lands')
    expect(await h.run('plur_recall', { query: 'quokka personal fact' }, onDir)).toContain('quokka')
    expect(await h.inject(onDir)).toContain('quokka')
  })
})
