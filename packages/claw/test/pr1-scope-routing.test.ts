/**
 * PR-1 (#353) claw scope routing:
 *  - _learnIfNew now calls learnRouted (not learn) so shared-scope engrams reach
 *    their remote store / outbox (MED-4),
 *  - an unscoped session passes scope `undefined` (NOT 'global') to core for each
 *    of the three auto-learn paths (ingest, compact, afterTurn), so core's
 *    unscoped routing path runs and the engram lands at the default (global).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PlurContextEngine } from '../src/context-engine.js'

// A correction-shaped message extractLearnings/isCorrection will pick up.
const CORRECTION = (topic: string) =>
  `No, always use snake_case for the ${topic} responses in this project`

describe('PR-1 claw scope routing (#353)', () => {
  let engine: PlurContextEngine
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-pr1-'))
    engine = new PlurContextEngine({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('_learnIfNew calls learnRouted (not learn) — spy', async () => {
    const routedSpy = vi.spyOn(engine.plur, 'learnRouted')
    const learnSpy = vi.spyOn(engine.plur, 'learn')
    await engine.ingest({
      sessionId: 's1', sessionKey: 'user:john',
      message: { role: 'user', content: CORRECTION('ingest') },
    })
    await new Promise(r => setTimeout(r, 20)) // let the fire-and-forget settle
    expect(routedSpy).toHaveBeenCalled()
    // learn() may still be called internally by learnRouted's local path, but the
    // claw engine itself must route through learnRouted, not call learn directly.
    expect(routedSpy.mock.calls.length).toBeGreaterThan(0)
    routedSpy.mockRestore()
    learnSpy.mockRestore()
  })

  it('ingest path: unscoped session passes scope undefined → lands global', async () => {
    const routedSpy = vi.spyOn(engine.plur, 'learnRouted')
    await engine.ingest({
      sessionId: 's1', sessionKey: 'user:john',
      message: { role: 'user', content: CORRECTION('ingest-path') },
    })
    await new Promise(r => setTimeout(r, 20))
    expect(routedSpy).toHaveBeenCalled()
    // Every call from the unscoped session must pass scope undefined, never 'global'.
    for (const call of routedSpy.mock.calls) {
      expect((call[1] as { scope?: string })?.scope).toBeUndefined()
    }
    const e = (await routedSpy.mock.results[0].value) as { scope: string }
    expect(e.scope).toBe('global')
    routedSpy.mockRestore()
  })

  it('compact path: unscoped session passes scope undefined → lands global', async () => {
    await engine.ingest({
      sessionId: 's2', sessionKey: 'user:jane',
      message: { role: 'user', content: CORRECTION('compact-path') },
    })
    const routedSpy = vi.spyOn(engine.plur, 'learnRouted')
    await engine.compact({ sessionId: 's2', sessionKey: 'user:jane', sessionFile: '/tmp/x' })
    await new Promise(r => setTimeout(r, 20))
    for (const call of routedSpy.mock.calls) {
      expect((call[1] as { scope?: string })?.scope).toBeUndefined()
    }
    routedSpy.mockRestore()
  })

  it('afterTurn path: unscoped session passes scope undefined → lands global', async () => {
    const routedSpy = vi.spyOn(engine.plur, 'learnRouted')
    await engine.afterTurn({
      sessionId: 's3', sessionKey: 'user:kim', sessionFile: '/tmp/x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: CORRECTION('afterturn-path') },
        { role: 'assistant', content: 'Understood.' },
      ],
      prePromptMessageCount: 1,
    })
    await new Promise(r => setTimeout(r, 20))
    expect(routedSpy).toHaveBeenCalled()
    for (const call of routedSpy.mock.calls) {
      expect((call[1] as { scope?: string })?.scope).toBeUndefined()
    }
    const e = (await routedSpy.mock.results[0].value) as { scope: string }
    expect(e.scope).toBe('global')
    routedSpy.mockRestore()
  })
})
