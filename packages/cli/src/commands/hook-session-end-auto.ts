import { readSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'

/**
 * plur hook-session-end-auto — SessionEnd hook that captures a session-end
 * episode and cleans up checkpoints when Claude Code terminates a session.
 *
 * Called by Claude Code's SessionEnd hook (shipped in v1.0.85). Provides
 * best-effort session lifecycle closure without requiring LLM access — no
 * engram suggestions are generated (that requires model access), only the
 * episode is captured and the checkpoint is cleaned up.
 *
 * Resume behavior: SessionEnd fires on true termination only, not on pause.
 * A resumed session creates a new session_id on restart, so no special
 * resume detection is needed here.
 *
 * Gaps this hook cannot cover (handled elsewhere):
 *   - Hard kills (SIGKILL) — un-hookable; orphan recovery in hook-inject
 *   - Non-Claude-Code transports — server-side timeout (enterprise#112)
 *
 * Input: JSON on stdin (Claude Code SessionEnd hook format)
 *   { session_id?: string, transcript_path?: string, cwd?: string }
 * Output: silent (exits 0)
 */

function readStdinSync(): Record<string, unknown> {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    while (true) {
      try {
        const n = readSync(0, buf, 0, buf.length, null)
        if (n === 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
      } catch {
        break
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function deriveSummary(transcriptPath: string | undefined, cwd: string | undefined): string {
  const cwdPart = cwd ? ` in ${cwd.split('/').slice(-2).join('/')}` : ''
  if (!transcriptPath) {
    return `Session${cwdPart} ended automatically (no transcript available)`
  }
  try {
    const content = readFileSync(transcriptPath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    return `Session${cwdPart} ended automatically. ${lines.length} transcript entries.`
  } catch {
    return `Session${cwdPart} ended automatically`
  }
}

function cleanupCheckpoint(sessionId: string | undefined): void {
  try {
    const plurDir = process.env.PLUR_PATH ?? join(homedir(), '.plur')
    const sessionsDir = join(plurDir, 'sessions')
    const keys = [sessionId, process.env.CLAUDE_SESSION_ID, String(process.ppid)]
      .filter(Boolean)
      .map(k => k!.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64))
    for (const key of keys) {
      const cp = join(sessionsDir, `${key}.checkpoint.json`)
      if (existsSync(cp)) { unlinkSync(cp); break }
    }
  } catch { /* best-effort */ }
}

function cleanupSessionMarker(): void {
  try {
    const dir = join(tmpdir(), 'plur-sessions')
    mkdirSync(dir, { recursive: true })
    const marker = join(dir, `${process.ppid || 'unknown'}.marker`)
    if (existsSync(marker)) unlinkSync(marker)
  } catch { /* best-effort */ }
}

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  if (!isPlurConfigured()) return

  const input = readStdinSync()
  const sessionId  = input.session_id     as string | undefined
  const transcriptPath = input.transcript_path as string | undefined
  const cwd        = input.cwd            as string | undefined

  const summary = deriveSummary(transcriptPath, cwd)

  const plur = createPlur(flags)

  try {
    plur.capture(summary, {
      session_id: sessionId,
      channel: 'session-end-hook',
    })
  } catch { /* best-effort — never block session termination */ }

  cleanupCheckpoint(sessionId)
  cleanupSessionMarker()
}
