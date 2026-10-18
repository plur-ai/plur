/**
 * Fails the run if any file in the developer's REAL PLUR store changed while
 * the CLI suite ran. Read-only: it records names, sizes and mtimes, never
 * contents, and never writes.
 *
 * Runs as a vitest `globalSetup` in the main process, before any worker has
 * applied test/setup/isolate-home.ts, so HOME and PLUR_PATH here are the
 * shell's. Guarded: `$HOME/.plur`, plus `$PLUR_PATH` when set elsewhere.
 *
 * Mode (resolveGuardMode):
 *   - CI (env CI=true or 1): `fail`. CI has no live PLUR client, so any change
 *     to the real store came from a test, and the run goes red.
 *   - Anywhere else: `warn`. A PLUR client running on a workstation during the
 *     suite (an MCP server, an editor hook) legitimately writes to the real
 *     store; the changed paths are printed so they can be told apart, but the
 *     run does not fail.
 *   - PLUR_TEST_HOME_GUARD=fail|warn|off overrides either default (`off` skips
 *     the snapshot entirely). An unrecognised value is ignored.
 *
 * In a root (whole-workspace) run this globalSetup spans every project, so a
 * leak from another package's tests (mcp, dsh, ...) is caught here too.
 */
import { existsSync, lstatSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

type Snapshot = Map<string, string>

function walk(dir: string, out: Snapshot): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (entry.isDirectory()) {
      out.set(full + '/', 'dir')
      walk(full, out)
    } else {
      out.set(full, `${st.size}:${st.mtimeMs}`)
    }
  }
}

function snapshot(roots: string[]): Snapshot {
  const out: Snapshot = new Map()
  for (const root of roots) {
    out.set(root + '/', existsSync(root) ? 'dir' : 'absent')
    if (existsSync(root)) walk(root, out)
  }
  return out
}

export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = []
  for (const [path, sig] of after) {
    const was = before.get(path)
    if (was === undefined) changes.push(`added    ${path}`)
    else if (was !== sig) changes.push(`changed  ${path}`)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push(`removed  ${path}`)
  }
  return changes.sort()
}

export type GuardMode = 'fail' | 'warn' | 'off'

export function resolveGuardMode(env: NodeJS.ProcessEnv = process.env): GuardMode {
  const explicit = env.PLUR_TEST_HOME_GUARD
  if (explicit === 'fail' || explicit === 'warn' || explicit === 'off') return explicit
  const ci = (env.CI ?? '').toLowerCase()
  return ci === 'true' || ci === '1' ? 'fail' : 'warn'
}

export default function setup(): (() => void) | void {
  const mode = resolveGuardMode()
  if (mode === 'off') return

  const roots = [resolve(homedir(), '.plur')]
  const plurPath = process.env.PLUR_PATH
  if (plurPath && !roots.includes(resolve(plurPath))) roots.push(resolve(plurPath))

  const before = snapshot(roots)

  return () => {
    const changes = diffSnapshots(before, snapshot(roots))
    if (changes.length === 0) return
    const shown = changes.slice(0, 50).join('\n  ')
    const more = changes.length > 50 ? `\n  ... and ${changes.length - 50} more` : ''
    const message =
      `REAL PLUR STORE CHANGED during the CLI test run (${roots.join(', ')}):\n  ${shown}${more}\n` +
      'A test (or a CLI process it spawned) reached the real home or store. ' +
      (mode === 'warn'
        ? 'Not failing the run (warn mode, the default outside CI): a live PLUR client on this machine may have written these.'
        : 'If a live PLUR client on this machine wrote these, rerun with PLUR_TEST_HOME_GUARD=warn.')
    if (mode === 'warn') {
      console.warn(message)
      return
    }
    // A throw from globalSetup teardown is printed as "error during close"
    // but leaves vitest 4.1's exit code at 0, so set the exit code too.
    process.exitCode = 1
    throw new Error(message)
  }
}
