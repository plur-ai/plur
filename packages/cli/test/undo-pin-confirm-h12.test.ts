/**
 * H12: an undo restores the rows a change replaced as they were. When that
 * puts a pin back into force (a row live and pinned before the change, not
 * after it), the undo is a pin grant, so under `pinning.agents: request` or
 * `deny` it needs the same terminal confirmation as `plur pin` (S1). Core's
 * change journal does not police undos, so the three undo commands —
 * `plur pins undo`, `plur consolidate --undo` and the journal undo behind
 * `plur enrich --undo` / `plur rescope --undo` — check before calling it.
 *
 * In-process with a stand-in store: stdin is not a terminal here, so a
 * confirmation that is asked for is refused (exit 1), and undoChange must not
 * have been called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('tty', async (orig) => ({ ...(await orig<typeof import('tty')>()), isatty: () => false }))

const fake = {
  policy: 'request' as 'allow' | 'request' | 'deny',
  change: null as any,
  undoChange: vi.fn(async (id: string) => ({ id: `undo-of-${id}`, kind: 'undo', rows: [] as unknown[] })),
}
vi.mock('../src/plur.js', async (orig) => ({
  ...(await orig<typeof import('../src/plur.js')>()),
  createPlur: () => ({
    getChange: (id: string) => (fake.change && fake.change.id === id ? fake.change : null),
    undoChange: fake.undoChange,
    pinPolicyFor: () => fake.policy,
    defaultActor: 'owner',
    close: () => {},
  }),
}))

import { run as pinsRun } from '../src/commands/pins.js'
import { run as consolidateRun } from '../src/commands/consolidate.js'
import { run as enrichRun } from '../src/commands/enrich.js'
import { run as rescopeRun } from '../src/commands/rescope.js'
import { undoRestoresPins } from '../src/lib/pin-confirm.js'

const row = (over: Record<string, unknown>) => ({ id: 'ENG-2026-11-21-001', statement: 'Never push to main', status: 'active', ...over })
function change(kind: string, before: any, after: any) {
  return { id: 'chg-1', kind, meta: { actor: 'owner' }, at: '2026-11-21T00:00:00Z', rows: [{ id: before?.id ?? after?.id, index: 0, before, after }] }
}

let exitSpy: ReturnType<typeof vi.spyOn>
let stderr = ''
beforeEach(() => {
  fake.policy = 'request'
  fake.change = null
  fake.undoChange.mockClear()
  stderr = ''
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => { stderr += c; return true }) as never)
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
})
afterEach(() => { vi.restoreAllMocks() })

describe('undo that puts a pin back needs the pin-policy confirmation (H12)', () => {
  it.each([
    ['plur pins undo', 'pins.apply', () => pinsRun(['undo', 'chg-1'], {})],
    ['plur enrich --undo', 'enrich.apply', () => enrichRun(['--undo', 'chg-1'], {})],
    ['plur rescope --undo', 'rescope.apply', () => rescopeRun(['--undo', 'chg-1'], {})],
  ])('%s that re-pins an unpinned row is refused from a non-terminal under request', async (_name, kind, call) => {
    fake.change = change(kind, row({ pinned: true }), row({}))
    await expect(call()).rejects.toThrow('exit 1')
    expect(stderr).toMatch(/interactive terminal/)
    expect(fake.undoChange).not.toHaveBeenCalled()
  })

  it('plur consolidate --undo that brings a retired pinned original back is refused from a non-terminal under deny', async () => {
    fake.policy = 'deny'
    // consolidation retires the originals with everything else unchanged (retireInto), pin included
    fake.change = change('consolidate.merge', row({ pinned: true }), row({ pinned: true, status: 'retired' }))
    await expect(consolidateRun(['--undo', 'chg-1'], {})).rejects.toThrow('exit 1')
    expect(stderr).toMatch(/interactive terminal/)
    expect(fake.undoChange).not.toHaveBeenCalled()
  })

  it('an undo that restores no pin, or any undo under allow, asks nothing', async () => {
    fake.change = change('pins.apply', row({ pinned: true, statement: 'long form' }), row({ pinned: true, statement: 'short' }))
    await pinsRun(['undo', 'chg-1'], {})
    expect(fake.undoChange).toHaveBeenCalledTimes(1)
    fake.policy = 'allow'
    fake.change = change('pins.apply', row({ pinned: true }), row({}))
    await pinsRun(['undo', 'chg-1'], {})
    expect(fake.undoChange).toHaveBeenCalledTimes(2)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('undoRestoresPins counts rows live and pinned before the change and not after it', () => {
    expect(undoRestoresPins(change('x', row({ pinned: true }), row({})) as any)).toBe(1)
    expect(undoRestoresPins(change('x', row({ pinned: true }), null) as any)).toBe(1)
    expect(undoRestoresPins(change('x', row({ pinned: true }), row({ pinned: true, status: 'retired' })) as any)).toBe(1)
    expect(undoRestoresPins(change('x', null, row({ pinned: true })) as any)).toBe(0)
    expect(undoRestoresPins(change('x', row({}), row({ pinned: true })) as any)).toBe(0)
    expect(undoRestoresPins(change('x', row({ pinned: true }), row({ pinned: true })) as any)).toBe(0)
  })
})
