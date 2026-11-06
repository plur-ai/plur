import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { agySentinelPath, agyCounterPath } from '../src/lib/agy-hook-io.js'

/**
 * Security audit 2026-11-06 (hardening): the agy turn cache replays a turn's
 * memory on every model invocation of that turn. A message cached while the
 * folder was `on` was replayed after the folder switched to `ask` (or any
 * other mode) within the same turn. The replay is dropped whenever the
 * cached folder mode differs from the current one.
 */

process.env.PLUR_HOOK_NO_EXIT = '1'
const SID = 'agy-turn-cache-mode-test'

let injectCalls: number
let bound: Array<{ dir: string; mode: string }>
let enqueued: Array<{ cwd?: string; workspaceScope?: string | null }>

vi.mock('../src/lib/codex-hook-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/codex-hook-io.js')>()
  return {
    ...actual,
    readStdinJson: () => (globalThis as Record<string, unknown>).__plurTurnModeStdin ?? {},
    injectWithFallback: async () => {
      injectCalls++
      return { result: { count: 1, directives: 'CANARY-DIRECTIVE', constraints: '', consider: '', injected_ids: [] }, mode: 'hybrid' }
    },
  }
})

vi.mock('../src/plur.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plur.js')>()
  return {
    ...actual,
    createPlur: () => ({
      isDirectoryTrusted: () => false,
      bindFolderPolicy: (dir: string, policy: { mode: string }) => { bound.push({ dir, mode: policy.mode }) },
      remoteOnlyFolder: () => null,
    }) as never,
  }
})

vi.mock('@plur-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plur-ai/core')>()
  return {
    ...actual,
    resolveProjectRemote: () => ({ config: {}, configDir: null, remoteProject: null, refusedFrom: null }),
    skippedStoreNotice: () => null,
  }
})

vi.mock('../src/lib/auto-rate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/auto-rate.js')>()
  return {
    ...actual,
    recordInjected: () => {},
    agyReplySinceLastUser: () => 'a reply worth rating',
    enqueueTurn: (o: { cwd?: string; workspaceScope?: string | null }) => { enqueued.push({ cwd: o.cwd, workspaceScope: o.workspaceScope }); return false },
    hasLeftoverBatches: () => false,
    spawnWorker: () => true,
  }
})

const { run: runPre } = await import('../src/commands/hook-agy-pre-invocation.js')

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PLUR_PATH: process.env.PLUR_PATH }
let home: string
let onDir: string
let offDir: string
let roDir: string
let written: string[]
let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

function setStdin(p: Record<string, unknown>): void { (globalThis as Record<string, unknown>).__plurTurnModeStdin = p }
function clean(): void {
  for (const n of ['turncache', 'turncount', 'guard-count']) rmSync(agyCounterPath(SID, n), { force: true })
  rmSync(agySentinelPath(SID), { force: true })
}

beforeEach(() => {
  clean()
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-agy-mode-')))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.PLUR_PATH = join(home, '.plur')
  mkdirSync(process.env.PLUR_PATH)
  onDir = join(home, 'work', 'p-on'); offDir = join(home, 'work', 'q-off'); roDir = join(home, 'work', 'r-ro')
  for (const d of [onDir, offDir, roDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(process.env.PLUR_PATH, 'folders.yaml'),
    `version: 1\nfolders:\n  - path: ${onDir}\n    plur: on\n  - path: ${offDir}\n    plur: off\n  - path: ${roDir}\n    plur: remote-only\n    scope: group:acme/eng\n`)
  injectCalls = 0
  bound = []
  enqueued = []
  written = []
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { if (String(c).length > 0) written.push(String(c)); return true }) as never)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  stdout.mockRestore()
  stderr.mockRestore()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(home, { recursive: true, force: true })
  clean()
})

function mapOn(mode: string): void {
  writeFileSync(join(process.env.PLUR_PATH as string, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${onDir}\n    plur: ${mode}\n`)
}
function transcriptFile(text: string): string {
  const p = join(home, 'transcript.jsonl')
  writeFileSync(p, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }) + '\n')
  return p
}

describe('agy turn cache: replayed only under the folder mode it was cached in', () => {
  it('memory cached while on is not replayed mid-turn after the folder switches to ask', async () => {
    mapOn('on')
    const t = transcriptFile('how do deploys work')
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: t, workspacePaths: [onDir] })
    await runPre([], {} as never)
    expect(written.join('')).toContain('CANARY-DIRECTIVE')

    mapOn('ask')
    written = []
    setStdin({ conversationId: SID, invocationNum: 1, transcriptPath: t, workspacePaths: [onDir] })
    await runPre([], {} as never)
    expect(written.join('')).not.toContain('CANARY-DIRECTIVE')
    expect(injectCalls).toBe(1)
  })

  it('a mid-turn invocation under the same mode still replays', async () => {
    mapOn('on')
    const t = transcriptFile('how do deploys work')
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: t, workspacePaths: [onDir] })
    await runPre([], {} as never)
    written = []
    setStdin({ conversationId: SID, invocationNum: 1, transcriptPath: t, workspacePaths: [onDir] })
    await runPre([], {} as never)
    expect(written.join('')).toContain('CANARY-DIRECTIVE')
    expect(injectCalls).toBe(1)
  })

  it('the ask question itself is replayed mid-turn while the folder stays ask', async () => {
    mapOn('ask')
    const t = transcriptFile('how do deploys work')
    setStdin({ conversationId: SID, invocationNum: 0, transcriptPath: t, workspacePaths: [onDir] })
    await runPre([], {} as never)
    const first = written.join('')
    expect(first.length).toBeGreaterThan(0)
    written = []
    setStdin({ conversationId: SID, invocationNum: 1, transcriptPath: t, workspacePaths: [onDir] })
    await runPre([], {} as never)
    expect(written.join('')).toBe(first)
  })
})
