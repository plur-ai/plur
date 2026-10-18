import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { normalizeEndpointUrl } from '@plur-ai/core'
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
  saved: { ok: true; id: string } | { ok: false; reason: string }
  perTool: Array<{ tool: ToolId; recalled: boolean; reason?: string }>
}

export function helloStatement(p: {
  username: string
  deviceName: string
  tools: string[]
  version: string
  date: string
}): string {
  return `PLUR connected: ${p.username} on ${p.deviceName}, ${p.tools.join(', ')}, PLUR ${p.version}, ${p.date}`
}

interface LearnResult {
  id?: string
  delivery?: string
  destination?: string
  plur?: string
}

interface RecallResult {
  results?: Array<{ id: string; statement?: string }>
  /** What the server (remote) leg did on THIS call (#1586). */
  remote?: { state?: string; hosts?: Array<{ host?: string; state?: string; count?: number }> }
  results_complete?: boolean
}

/**
 * Whether one recall answer proves the round trip (Codex round 4, finding 1).
 * The id coming back is not enough: a row can come from a cache while the
 * server's recall failed. Proven only when this call's server leg answered
 * completely (`remote.state` ok, `results_complete` true), the intended
 * server is among the hosts it dialed and answered ok with at least one row,
 * and the saved id is in the results. Returns null when proven, else why not.
 */
function recallShortfall(r: RecallResult | undefined, savedId: string, serverKey: string, label: string): string | null {
  const notRecalled = `saved, but ${label}'s environment could not recall it`
  const remote = r?.remote
  const host = remote?.hosts?.find((h) => typeof h.host === 'string' && h.host === serverKey)
  if (!remote || remote.state !== 'ok' || r?.results_complete !== true || !host || host.state !== 'ok') {
    const state = host?.state ?? (remote ? (remote.state ?? 'unknown') : 'no report')
    return `saved, but ${label}'s recall did not get a complete answer from the server (${state})`
  }
  if (!(typeof host.count === 'number' && host.count >= 1)) return notRecalled
  return r?.results?.some((x) => x.id === savedId) ? null : notRecalled
}

function failReason(result: LearnResult): string | null {
  if (result.plur === 'off') {
    return 'PLUR is turned off in this environment'
  }
  if (result.delivery === 'remote') {
    return typeof result.id === 'string' && result.id.length > 0
      ? null
      : 'the server did not return an id for the saved memory'
  }
  if (result.delivery === 'outbox') {
    return 'queued on this device, not delivered to the server'
  }
  if (result.delivery === 'local') {
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
  const perTool: HelloResult['perTool'] = []

  if (opts.launches.length === 0) {
    return { saved: { ok: false, reason: 'no tool launches provided' }, perTool: [] }
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
        saved: { ok: false, reason: e instanceof Error ? e.message : String(e) },
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
        learnArgs.supersedes = [opts.previousId]
      }
      const learnResult = (await session.callTool('plur_learn', learnArgs)) as LearnResult
      const reason = failReason(learnResult)
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
    // the server that holds it; `recallShortfall` checks that it did.
    const recallArgs = { query: opts.statement, scope: opts.personalScope }
    const serverKey = normalizeEndpointUrl(opts.serverUrl)

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
