/**
 * #1825: the first remote recall in a `plur recall` process gets the same
 * 5,000 ms warm-up budget as plur_session_start. On a cold client the first
 * call missed the normal budget while later calls answered in about 1 s.
 * Later calls in the same process keep the normal budget (core default), and
 * PLUR_REMOTE_RECALL_TIMEOUT_MS still wins inside core.
 *
 * Each case re-imports the command module (vi.resetModules), so each starts
 * as a new process would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const engram = {
  id: 'ENG-1', statement: 'a fact', scope: 'global', type: 'behavioral',
  activation: { retrieval_strength: 0.5 },
}
const meta = () => ({ engrams: [engram], remote: { state: 'ok', hosts: [] }, results_complete: true })

const mockPlur = {
  recallWithMeta: vi.fn(async () => meta()),
  recallHybridWithMeta: vi.fn(async () => meta()),
}

const folderReadContext = vi.fn((): { remote?: boolean; session?: string } => ({}))

vi.mock('../src/plur.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/plur.js')>()
  return { ...mod, createPlur: () => mockPlur as never }
})
vi.mock('../src/lib/folder-gate.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lib/folder-gate.js')>()
  return { ...mod, folderReadContext: (...a: unknown[]) => folderReadContext(...(a as [])) }
})

async function loadRun() {
  vi.resetModules()
  return (await import('../src/commands/recall.js')).run
}

describe('plur recall: first remote call gets the warm-up budget (#1825)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
    folderReadContext.mockReturnValue({})
  })
  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  for (const mode of ['hybrid', 'fast'] as const) {
    const spy = () => (mode === 'fast' ? mockPlur.recallWithMeta : mockPlur.recallHybridWithMeta)
    const flags = { json: true, ...(mode === 'fast' ? { fast: true } : {}) }

    it(`${mode}: the first call passes 5000 ms, the second passes no budget`, async () => {
      const run = await loadRun()
      await run(['q', '--scope', 'group:o/t'], flags)
      await run(['q', '--scope', 'group:o/t'], flags)
      const calls = spy().mock.calls as unknown as Array<[string, { remote_timeout_ms?: number }]>
      expect(calls).toHaveLength(2)
      expect(calls[0][1].remote_timeout_ms).toBe(5000)
      expect(calls[1][1].remote_timeout_ms).toBeUndefined()
    })

    it(`${mode}: a call that contacts no store does not use up the warm-up`, async () => {
      const run = await loadRun()
      folderReadContext.mockReturnValueOnce({ remote: false })
      await run(['q'], flags)
      await run(['q', '--scope', 'group:o/t'], flags)
      const calls = spy().mock.calls as unknown as Array<[string, { remote_timeout_ms?: number }]>
      expect(calls).toHaveLength(2)
      expect(calls[0][1].remote_timeout_ms).toBeUndefined()
      expect(calls[1][1].remote_timeout_ms).toBe(5000)
    })
  }
})
