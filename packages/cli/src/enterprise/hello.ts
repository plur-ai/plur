import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectSensitive, normalizeEndpointUrl, parseNamespacedId, storePrefix, legacyStorePrefix } from '@plur-ai/core'
import { openMcpSession, type McpLaunch } from './mcp-stdio.js'

export type { McpLaunch }

export type ToolId = 'claude-code' | 'codex' | 'opencode' | 'cursor'

export const TOOL_LABEL: Record<ToolId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
}

export interface HelloResult {
  saved: { ok: true; id: string } | { ok: false; reason: string; notAttempted?: true }
  perTool: Array<{ tool: ToolId; recalled: boolean; reason?: string }>
}

export function helloStatement(p: {
  username: string
  deviceName: string
  tools: string[]
  version: string
  date: string
}): string {
  const label = detectSensitive(p.deviceName).length ? 'private device' : p.deviceName
  return `PLUR connected: ${p.username} on ${label}, ${p.tools.join(', ')}, PLUR ${p.version}, ${p.date}`
}

interface LearnResult {
  id?: string
  delivery?: string
  demoted?: boolean
  /** The server that holds the saved memory, as a normalized endpoint (Codex round 5). */
  delivered_to?: string
  destination?: string
  plur?: string
}

interface RecallResult {
  results?: Array<{ id: string; statement?: string }>
  /** What the server (remote) leg did on THIS call (#1586), with the ids each host returned. */
  remote?: { state?: string; hosts?: Array<{ host?: string; state?: string; count?: number; ids?: unknown }> }
  results_complete?: boolean
}

/** A server named in a reason: its origin only, never userinfo, path or query. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'another server'
  }
}

/**
 * Whether one recall answer proves that the intended server returned the
 * saved id (Codex rounds 4 and 5). Proven only when a host report for the
 * intended server (by endpoint identity) answered ok on THIS call and lists
 * the saved id among the rows it returned itself. The merged `results` are
 * not used: one server's ids can equal another's, and a cached row can stand
 * in for a failed server. Nor are `results_complete` or `remote.state`: they
 * also cover local semantic search and other servers, which say nothing
 * about this one. Returns null when proven, else why not.
 */
function recallShortfall(r: RecallResult | undefined, savedId: string, serverKey: string, label: string): string | null {
  const notRecalled = `saved, but ${label}'s environment could not recall it`
  const mine = (r?.remote?.hosts ?? []).filter((h) => typeof h.host === 'string' && h.host === serverKey)
  if (mine.length === 0 || !mine.some((h) => h.state === 'ok')) {
    const state = mine[0]?.state ?? (r?.remote ? 'not dialed' : 'no report')
    return `saved, but ${label}'s recall did not get an answer from the server (${state})`
  }
  const returned = mine.some((h) => h.state === 'ok' && Array.isArray(h.ids) && h.ids.includes(savedId))
  return returned ? null : notRecalled
}

function failReason(result: LearnResult, serverKey: string, serverUrl: string): string | null {
  if (result.plur === 'off') {
    return 'PLUR is turned off in this environment'
  }
  if (result.delivery === 'remote') {
    if (!(typeof result.id === 'string' && result.id.length > 0)) {
      return 'the server did not return an id for the saved memory'
    }
    // The save must have reached THIS server (Codex round 5, finding 2): with
    // several servers on the personal scope, another one can take the write.
    if (typeof result.delivered_to !== 'string') {
      return `saved, but this environment did not say which server received it, so it is not confirmed on ${originOf(serverUrl)}`
    }
    if (normalizeEndpointUrl(result.delivered_to) !== serverKey) {
      return `saved to a different server (${originOf(result.delivered_to)}), not to ${originOf(serverUrl)}`
    }
    return null
  }
  if (result.delivery === 'outbox') {
    return 'queued on this device, not delivered to the server'
  }
  if (result.delivery === 'local') {
    if (result.demoted === true) return 'the privacy check kept sensitive content on this device; nothing was delivered to the server'
    return 'saved locally, not delivered to the server'
  }
  if (result.destination) {
    return result.destination
  }
  return `unexpected delivery: ${result.delivery ?? 'unknown'}`
}

export async function runHello(opts: {
  launches: Array<{ tool: ToolId; launch: McpLaunch }>
  personalScope: string
  /** The server the save must have reached; a recall proves only when THIS server answered it. */
  serverUrl: string
  statement: string
  previousId?: string
  timeoutMs?: number
}): Promise<HelloResult> {
  const timeout = opts.timeoutMs ?? 30000
  const serverKey = normalizeEndpointUrl(opts.serverUrl)
  const perTool: HelloResult['perTool'] = []

  if (opts.launches.length === 0) {
    return { saved: { ok: false, reason: 'no tool launches provided', notAttempted: true }, perTool: [] }
  }

  // Fresh neutral cwd — not process.cwd() or HOME
  const neutralCwd = mkdtempSync(join(tmpdir(), 'plur-hello-'))

  try {
    // A fresh folder has no decision, and the MCP server's folder gate answers
    // an undecided folder with the folder question instead of saving. Memory
    // is switched on for THIS folder only, by a project marker inside it: an
    // empty `.plur.yaml` (requests no scope, domain or remote). The user's
    // folder map is never written, the marker goes with the folder below, and
    // a folder-map `off` that covers this folder still wins.
    writeFileSync(join(neutralCwd, '.plur.yaml'), '# PLUR connection check: memory is on in this temporary folder\n')

    const { launch: firstLaunch } = opts.launches[0]

    // Open session for the first launch (the save)
    let session
    try {
      session = await openMcpSession(firstLaunch, { cwd: neutralCwd, timeoutMs: timeout })
    } catch (e) {
      return {
        saved: { ok: false, reason: e instanceof Error ? e.message : String(e), notAttempted: true },
        perTool: [],
      }
    }

    // Save through the first launch
    let savedId: string
    try {
      const learnArgs: Record<string, unknown> = {
        statement: opts.statement,
        scope: opts.personalScope,
        domain: 'plur.connect',
        tags: ['plur-connect'],
      }
      if (opts.previousId) {
        // Config keeps the display id used by MCP recall. The server relation
        // needs its own id, without this personal store's display namespace.
        const parsed = parseNamespacedId(opts.previousId, true)
        const ownPrefix = parsed && [storePrefix(opts.personalScope), legacyStorePrefix(opts.personalScope)].includes(parsed.prefix)
        learnArgs.supersedes = [ownPrefix ? parsed.bare : opts.previousId]
      }
      const learnResult = (await session.callTool('plur_learn', learnArgs)) as LearnResult
      const reason = failReason(learnResult, serverKey, opts.serverUrl)
      if (reason !== null) {
        await session.close()
        return { saved: { ok: false, reason }, perTool: [] }
      }
      savedId = learnResult.id!
    } catch (e) {
      await session.close()
      return {
        saved: { ok: false, reason: e instanceof Error ? e.message : String(e) },
        perTool: [],
      }
    }

    // The saving process is closed before any recall: a successful save puts
    // the row in that process's optimistic cache, where a recall would find
    // it even when the server's recall fails (Codex round 4, finding 1).
    await session.close()

    // plur_recall is exposed by the server's default tool profile
    // (plur_recall_hybrid is not). The personal scope makes the recall dial
    // the server that holds it; `recallShortfall` checks that it did. Keyword
    // mode: the proof is about the server, and a fresh install may not have
    // the local embedding model yet (Codex round 5, finding 1).
    const recallArgs = { query: opts.statement, scope: opts.personalScope, mode: 'keyword' }

    // Every launch — the saving one included — recalls from a fresh process.
    for (const { tool, launch } of opts.launches) {
      const label = TOOL_LABEL[tool]
      let s
      try {
        s = await openMcpSession(launch, { cwd: neutralCwd, timeoutMs: timeout })
      } catch {
        perTool.push({ tool, recalled: false, reason: `saved, but ${label}'s environment could not recall it` })
        continue
      }
      try {
        const recallResult = (await s.callTool('plur_recall', recallArgs)) as RecallResult
        const reason = recallShortfall(recallResult, savedId, serverKey, label)
        perTool.push(reason === null ? { tool, recalled: true } : { tool, recalled: false, reason })
      } catch {
        perTool.push({ tool, recalled: false, reason: `saved, but ${label}'s environment could not recall it` })
      } finally {
        await s.close().catch(() => undefined)
      }
    }

    return { saved: { ok: true, id: savedId }, perTool }
  } finally {
    try {
      rmSync(neutralCwd, { recursive: true, force: true })
    } catch {
      // best effort (Windows can refuse while a handle is still closing)
    }
  }
}
