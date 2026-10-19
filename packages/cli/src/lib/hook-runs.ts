import { atomicWrite, withLock } from '@plur-ai/core'
import { mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type HookTool = 'claude' | 'codex' | 'cursor'
type Tool = HookTool
type HookRuns = Partial<Record<Tool, string>>
const tools: Tool[] = ['claude', 'codex', 'cursor']
const defaultRoot = () => process.env.PLUR_PATH || join(homedir(), '.plur')

function readTimes(file: string, root: string): HookRuns {
  try {
    const raw = JSON.parse(readFileSync(join(root, file), 'utf8'))
    return Object.fromEntries(tools.filter(tool => typeof raw?.[tool] === 'string' && Number.isFinite(Date.parse(raw[tool])))
      .map(tool => [tool, raw[tool]]))
  } catch { return {} }
}

export function readHookRuns(root = defaultRoot()): HookRuns { return readTimes('hook-runs.json', root) }
export function readHookInstalls(root = defaultRoot()): HookRuns { return readTimes('hook-installs.json', root) }

/** Invalidate old evidence before replacing hooks, then record a successful install. */
export function recordHookInstall(tool: Tool, root = defaultRoot(), changed = true, write: () => void = () => {}): void {
  try {
    mkdirSync(root, { recursive: true })
    const path = join(root, 'hook-installs.json')
    withLock(path, () => {
      const times = readHookInstalls(root)
      const renew = changed || !times[tool]
      // A crash or failed final write leaves a non-date, which doctor cannot
      // mistake for a previous successful install. If this first write fails,
      // the caller's hook configuration is not changed.
      if (renew) atomicWrite(path, JSON.stringify({ ...times, [tool]: 'pending' }) + '\n', { mode: 0o600 })
      write()
      if (renew) atomicWrite(path, JSON.stringify({ ...times, [tool]: new Date().toISOString() }) + '\n', { mode: 0o600 })
    }, { maxRetries: 1 })
  } catch {
    throw new Error('Hook installation could not be recorded safely; hook trust is not verified. Resolve the installation-record or hook-file write failure, then run plur init again.')
  }
}

/** Trust evidence only; no prompt, workspace, identity or memory content. */
export function recordHookRun(tool: Tool, root = defaultRoot()): void {
  try {
    mkdirSync(root, { recursive: true })
    const path = join(root, 'hook-runs.json')
    withLock(path, () => atomicWrite(path, JSON.stringify({ ...readHookRuns(root), [tool]: new Date().toISOString() }) + '\n', { mode: 0o600 }), { maxRetries: 1 })
  } catch {
    process.stderr.write('[plur] Could not record the session-start hook run; hook trust is not verified.\n')
  }
}
