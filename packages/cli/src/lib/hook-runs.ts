import { atomicWrite, withLock } from '@plur-ai/core'
import { mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type Tool = 'claude' | 'codex' | 'cursor'
type HookRuns = Partial<Record<Tool, string>>
const tools: Tool[] = ['claude', 'codex', 'cursor']
const defaultRoot = () => process.env.PLUR_PATH || join(homedir(), '.plur')

export function readHookRuns(root = defaultRoot()): HookRuns {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'hook-runs.json'), 'utf8'))
    return Object.fromEntries(tools.filter(tool => typeof raw?.[tool] === 'string' && Number.isFinite(Date.parse(raw[tool])))
      .map(tool => [tool, raw[tool]]))
  } catch { return {} }
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
