import { openSync, readSync, closeSync, fstatSync, existsSync, statSync, constants } from 'fs'
import { dirname, join, resolve, isAbsolute } from 'path'

/**
 * Build the injection query from session context (retrieval and injection
 * overhaul, W5).
 *
 * A raw prompt is a poor query when it carries no content ("do 1,2,3",
 * "go ahead") or is an event label ("skill: review"). Then the hook adds what
 * it knows about the session: the stored session task (`writeSessionTask`),
 * the project scope's label, the git branch of the working directory, and the
 * last two user turns from the payload's transcript. Core searches with the
 * task plus these parts and records the query used (`InjectionResult.query`).
 *
 * Every read here is bounded and swallows its own failure: a hook must never
 * break the prompt for want of context.
 */

/** Function words that carry no retrieval signal. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
  'has', 'have', 'him', 'his', 'how', 'its', 'let', 'may', 'now', 'see', 'she', 'too', 'use', 'way', 'who', 'did',
  'yes', 'yet', 'get', 'got', 'this', 'that', 'with', 'from', 'they', 'them', 'then', 'than', 'what', 'when', 'where',
  'which', 'will', 'would', 'could', 'should', 'there', 'their', 'these', 'those', 'into', 'onto', 'just', 'also',
  'some', 'such', 'only', 'over', 'very', 'been', 'being', 'were', 'does', 'done', 'doing', 'here', 'about', 'again',
  'please', 'thanks', 'thank', 'okay', 'sure', 'ahead', 'go', 'do', 'it', 'ok', 'next', 'more', 'same', 'like',
  'make', 'want', 'need', 'look', 'try', 'well', 'good', 'fine', 'right', 'continue', 'proceed', 'carry', 'keep',
  'start', 'stop', 'step', 'steps', 'thing', 'things', 'stuff', 'that', 'your', 'mine', 'yours', 'each', 'every',
])

/** Content words: letters/digits runs of 3+ characters, not all digits, not a stopword. */
export function contentWordCount(text: string): number {
  let n = 0
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)) {
    const w = m[0]
    if (w.length < 3 || /^\d+$/.test(w) || STOPWORDS.has(w)) continue
    n++
  }
  return n
}

/** The labels `hook-inject --event` uses as its task (see `extractEventTask`). */
export function isEventLabel(text: string): boolean {
  const t = text.trim().toLowerCase()
  return /^(skill|agent|subagent):/.test(t)
    || t === 'skill invocation' || t === 'agent task' || t === 'subagent task'
    || t === 'implementation planning and architecture'
}

/** A scope as search words: `project:invoice-tools` → `invoice tools`, `group:acme/eng` → `acme eng`. */
export function scopeLabel(scope: string | undefined | null): string {
  if (!scope) return ''
  return scope.replace(/^[a-z]+:/i, '').replace(/[/:._-]+/g, ' ').trim()
}

/** A branch as search words: `feat/invoice-retries` → `feat invoice retries`. */
function branchLabel(branch: string | null | undefined): string {
  return branch ? branch.replace(/[/:._-]+/g, ' ').trim() : ''
}

/** Read at most `max` bytes of a small file, or null. */
/**
 * Open `path` for reading only if it is a regular file (H11): checked before
 * the open, and the open is O_NONBLOCK, so a FIFO or device planted where a
 * git HEAD or a transcript is expected can never block the hook's
 * synchronous open (the watchdog cannot fire while the thread is blocked).
 * Callers still fstat the fd (a swap between the check and the open).
 */
function openRegularFile(path: string): number | null {
  try { if (!statSync(path).isFile()) return null } catch { return null }
  return openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
}

function readSmall(path: string, max = 4096): string | null {
  let fd: number | null = null
  try {
    fd = openRegularFile(path)
    if (fd === null) return null
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const buf = Buffer.alloc(Math.min(max, st.size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
  }
}

/**
 * The checked-out branch of the repository containing `cwd`, read from
 * `.git/HEAD` (no git process). Follows a worktree's `.git` file to its
 * gitdir. Null when detached, absent or unreadable. At most 40 levels up.
 */
export function readGitBranch(cwd: string | undefined | null): string | null {
  if (!cwd) return null
  try {
    let dir = resolve(cwd)
    for (let i = 0; i < 40; i++) {
      const dotGit = join(dir, '.git')
      if (existsSync(dotGit)) {
        let gitDir = dotGit
        if (statSync(dotGit).isFile()) {
          const ref = readSmall(dotGit)?.match(/^gitdir:\s*(.+)\s*$/m)?.[1]
          if (!ref) return null
          gitDir = isAbsolute(ref) ? ref : resolve(dir, ref)
        }
        const head = readSmall(join(gitDir, 'HEAD'), 1024)
        const m = head?.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)
        return m ? m[1] : null
      }
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
  } catch { /* fail open */ }
  return null
}

/** The user-typed text of a transcript entry, or null for tool results and system-tagged text. */
function userText(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as { type?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } }
  if (e.type !== 'user' || e.isMeta === true) return null
  const msg = e.message
  if (!msg || msg.role !== 'user') return null
  let text = ''
  if (typeof msg.content === 'string') text = msg.content
  else if (Array.isArray(msg.content)) {
    const parts = msg.content as Array<{ type?: unknown; text?: unknown }>
    if (parts.some(p => p?.type === 'tool_result')) return null
    text = parts.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join(' ')
  }
  text = text.trim()
  // Command echoes, reminders and other harness-injected text start with a tag.
  if (!text || text.startsWith('<')) return null
  return text.slice(0, 500)
}

/**
 * The last `n` user turns of a Claude Code transcript (JSONL), oldest first.
 * Reads only the final `maxBytes` of the file; never throws.
 */
export function readLastUserTurns(transcriptPath: unknown, n = 2, maxBytes = 256 * 1024): string[] {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return []
  let fd: number | null = null
  try {
    fd = openRegularFile(transcriptPath)
    if (fd === null) return []
    const st = fstatSync(fd)
    if (!st.isFile() || st.size === 0) return []
    const len = Math.min(maxBytes, st.size)
    const buf = Buffer.alloc(len)
    const got = readSync(fd, buf, 0, len, st.size - len)
    let lines = buf.subarray(0, got).toString('utf8').split('\n')
    if (len < st.size) lines = lines.slice(1) // the first line is cut
    const out: string[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      const t = userText(parsed)
      if (t) out.push(t)
    }
    return out.reverse()
  } catch {
    return []
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
  }
}

export interface HookQueryInput {
  prompt: string
  isEvent: boolean
  sessionTask: string
  scope: string | undefined
  branch: string | null
  turns: string[]
  minTerms: number
}

/**
 * The context parts to extend the query with, or none when the prompt is
 * specific enough (at least `minTerms` content words and not an event label).
 */
export function buildHookQueryContext(q: HookQueryInput): { extended: boolean; context: string[] } {
  if (!q.isEvent && !isEventLabel(q.prompt) && contentWordCount(q.prompt) >= q.minTerms) return { extended: false, context: [] }
  const context = [q.sessionTask.trim(), scopeLabel(q.scope), branchLabel(q.branch), ...q.turns.map(t => t.trim())]
    .filter(s => s.length > 0 && s !== q.prompt.trim())
  return { extended: context.length > 0, context }
}
