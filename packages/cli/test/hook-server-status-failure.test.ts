import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '@plur-ai/core'
import { run } from '../src/commands/hook-cursor-session-start.js'
import * as io from '../src/lib/cursor-hook-io.js'
import * as codexIo from '../src/lib/codex-hook-io.js'
import * as fs from 'fs'
import { run as runCodex } from '../src/commands/hook-codex-session-start.js'
import { run as runClaude } from '../src/commands/hook-inject.js'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, readSync: vi.fn(actual.readSync) }
})

let root: string, repo: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-status-failure-'))); repo = join(root, 'repo'); mkdirSync(repo)
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false } }))
  writeFileSync(join(root, 'folders.yaml'), `folders:\n  - path: ${JSON.stringify(repo)}\n    plur: on\n`)
  const plur = new Plur({ path: root, autoDiscover: false })
  await plur.learn('At general session start, canary deployment validates a release before rollout', { type: 'behavioral', domain: 'deployment' })
  plur.close()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
it.each([['cursor', run], ['codex', runCodex], ['claude', runClaude]] as const)('%s retains successful memory when cached status fails', async (_tool, command) => {
  const input = { conversation_id: root, session_id: root, workspace_roots: [repo], cwd: repo, source: 'startup', hook_event_name: 'UserPromptSubmit' }
  vi.stubEnv('PLUR_HOOK_NO_EXIT', '1')
  vi.stubEnv('PLUR_HOOK_HYBRID', 'off')
  vi.stubEnv('TMPDIR', root)
  vi.spyOn(io, 'readStdinJson').mockReturnValue(input)
  vi.spyOn(codexIo, 'readStdinJson').mockReturnValue(input)
  vi.spyOn(codexIo, 'markSessionStarted').mockImplementation(() => {})
  const originalRead = (await vi.importActual<typeof import('fs')>('fs')).readSync
  let read = false
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, ...args: any[]) => {
    if (fd !== 0) return (originalRead as any)(fd, buffer, ...args)
    if (read) return 0
    read = true
    return buffer.write(JSON.stringify(input))
  }) as any)
  vi.spyOn(io, 'markSessionStarted').mockImplementation(() => {})
  vi.spyOn(Plur.prototype, 'serverSessionLines').mockRejectedValue(new Error('fixture status unavailable'))
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => {
    const callback = args.find(a => typeof a === 'function'); callback?.(); return true
  }) as any)
  await command([], { path: root })
  const parsed = JSON.parse(String(output.mock.calls.find(c => String(c[0]).startsWith('{'))![0]))
  const context = parsed.additional_context ?? parsed.hookSpecificOutput.additionalContext
  expect(context).toContain('session started')
  expect(context).toContain('At general session start, canary deployment validates a release before rollout')
  expect(context).toContain('cached status could not be read')
  expect(context).not.toContain('injection FAILED')
})
