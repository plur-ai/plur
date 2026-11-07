import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { agySentinelPath, agyCounterPath } from '../src/lib/agy-hook-io.js'

/**
 * Security audit 2026-11-06: the Antigravity hooks decided the folder policy
 * from workspacePaths[0] only, so a later root the user turned off (or set to
 * remote-only) was ignored whenever an `on` root came first. Every root must
 * count, as for Cursor and the MCP gate: off wins, remote-only fails closed,
 * a non-string entry is off, and an empty list keeps the install-is-opt-in
 * behaviour.
 */

process.env.PLUR_HOOK_NO_EXIT = '1'
const SID = 'agy-all-roots-test'

let injectCalls: number
let bound: Array<{ dir: string; mode: string }>
let enqueued: Array<{ cwd?: string; workspaceScope?: string | null }>

vi.mock('../src/lib/codex-hook-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/codex-hook-io.js')>()
  return {
    ...actual,
    readStdinJson: () => (globalThis as Record<string, unknown>).__plurAllRootsStdin ?? {},
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
const { run: runGuard } = await import('../src/commands/hook-agy-guard.js')
const { run: runAutoRate } = await import('../src/commands/hook-auto-rate.js')

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PLUR_PATH: process.env.PLUR_PATH }
let home: string
let onDir: string
let offDir: string
let roDir: string
let written: string[]
let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

function setStdin(p: Record<string, unknown>): void { (globalThis as Record<string, unknown>).__plurAllRootsStdin = p }
function clean(): void {
  for (const n of ['turncache', 'turncount', 'guard-count']) rmSync(agyCounterPath(SID, n), { force: true })
  rmSync(agySentinelPath(SID), { force: true })
}

beforeEach(() => {
  clean()
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-agy-roots-')))
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

describe('agy pre-invocation: every workspace root decides', () => {
  it('[on, off] is silent: no recall, nothing injected', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, workspacePaths: [onDir, offDir] })
    await runPre([], {} as never)
    expect(injectCalls).toBe(0)
    expect(written).toEqual([])
  })

  it('[on, remote-only] binds the session remote-only', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, workspacePaths: [onDir, roDir] })
    await runPre([], {} as never)
    expect(bound.length).toBeGreaterThan(0)
    expect(bound.every(b => b.mode === 'remote-only')).toBe(true)
  })

  it('a non-string entry is off', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, workspacePaths: [onDir, 42] })
    await runPre([], {} as never)
    expect(injectCalls).toBe(0)
    expect(written).toEqual([])
  })

  it('an empty list keeps the install-is-opt-in behaviour', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, workspacePaths: [] })
    await runPre([], {} as never)
    expect(injectCalls).toBe(1)
  })

  it('[on] alone still recalls, bound on', async () => {
    setStdin({ conversationId: SID, invocationNum: 0, workspacePaths: [onDir] })
    await runPre([], {} as never)
    expect(injectCalls).toBe(1)
    expect(bound).toEqual([{ dir: onDir, mode: 'on' }])
  })
})

describe('agy guard: every workspace root decides', () => {
  it('[on, off] is silent (no deny)', async () => {
    setStdin({ conversationId: SID, toolCall: { name: 'run_command' }, workspacePaths: [onDir, offDir] })
    await runGuard([], {} as never)
    expect(written).toEqual([])
  })

  it('[on] alone still denies before session start', async () => {
    setStdin({ conversationId: SID, toolCall: { name: 'run_command' }, workspacePaths: [onDir] })
    await runGuard([], {} as never)
    expect(JSON.parse(written.at(-1) ?? '{}').decision).toBe('deny')
  })
})

describe('agy auto-rate: every workspace root decides', () => {
  it('[on, off] rates nothing', async () => {
    setStdin({ conversationId: SID, transcriptPath: '/nonexistent', workspacePaths: [onDir, offDir] })
    await runAutoRate(['agy'], {} as never)
    expect(enqueued).toEqual([])
  })

  it('[on, remote-only] never queues the turn as the on root', async () => {
    setStdin({ conversationId: SID, transcriptPath: '/nonexistent', workspacePaths: [onDir, roDir] })
    await runAutoRate(['agy'], {} as never)
    expect(enqueued.filter(e => e.cwd === onDir)).toEqual([])
  })

  it('[on] alone is queued for the on root', async () => {
    setStdin({ conversationId: SID, transcriptPath: '/nonexistent', workspacePaths: [onDir] })
    await runAutoRate(['agy'], {} as never)
    expect(enqueued.map(e => e.cwd)).toEqual([onDir])
  })
})
