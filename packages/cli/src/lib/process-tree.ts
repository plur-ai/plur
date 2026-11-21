import type { ChildProcess } from 'child_process'

/**
 * Stop a process the CLI started AND everything it started: doctor's server
 * check (#1911) and the model bridge's command (H16). A launcher —
 * `npx -y @plur-ai/mcp@latest`, `/bin/sh -lc 'exec npx …'`, the shell that
 * runs `--llm-cmd` — is not the process doing the work; that is its child,
 * and a kill aimed at the launcher alone leaves it running (for doctor,
 * writing into ~/.plur after doctor has reported). On POSIX the child is
 * spawned `detached`, so it leads its own process group and the whole tree is signalled at once: SIGTERM, then SIGKILL
 * after a short grace if anything in the group is still there. The grace
 * timer is unref'd, so it never holds the CLI open. Windows has no process
 * groups; there only the spawned process is stopped (known gap, see #1911).
 */
export function stopProcessTree(proc: ChildProcess, graceMs = 1000): void {
  try { proc.stdin?.end() } catch { /* ignore */ }
  const pid = proc.pid
  if (process.platform === 'win32' || !pid) {
    try { proc.kill() } catch { /* ignore */ }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // No such group (already gone, or not a group leader) — fall back.
    try { proc.kill() } catch { /* ignore */ }
    return
  }
  setTimeout(() => {
    try { process.kill(-pid, 0) } catch { return } // group is gone
    try { process.kill(-pid, 'SIGKILL') } catch { /* ignore */ }
  }, graceMs).unref()
}

/**
 * While a detached tree is running, a signal that stops the CLI (Ctrl-C
 * included — the terminal sends it to the CLI's process group, which the
 * detached tree has left) must stop the tree too. Returns the function that
 * removes the handlers; each handler stops the tree, removes them, and
 * re-raises the signal so the CLI ends as it would have without them.
 */
export function stopTreeOnSignal(proc: ChildProcess): () => void {
  if (process.platform === 'win32') return () => {}
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const handler = (sig: NodeJS.Signals) => {
    remove()
    stopProcessTree(proc)
    process.kill(process.pid, sig)
  }
  const remove = () => { for (const s of signals) process.removeListener(s, handler) }
  for (const s of signals) process.on(s, handler)
  return remove
}
