import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
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
    const { tool: firstTool, launch: firstLaunch } = opts.launches[0]

    // Open session for the first launch (save + recall)
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

    // plur_recall is exposed by the server's default tool profile
    // (plur_recall_hybrid is not). The personal scope makes the recall dial
    // the server that holds it, so a hit proves the round trip.
    const recallArgs = { query: opts.statement, scope: opts.personalScope }

    // Recall from the first launch (session still open)
    try {
      const recallResult = (await session.callTool('plur_recall', recallArgs)) as RecallResult
      const recalled = recallResult?.results?.some((r) => r.id === savedId) ?? false
      if (recalled) {
        perTool.push({ tool: firstTool, recalled: true })
      } else {
        perTool.push({
          tool: firstTool,
          recalled: false,
          reason: `saved, but ${TOOL_LABEL[firstTool]}'s environment could not recall it`,
        })
      }
    } catch {
      perTool.push({
        tool: firstTool,
        recalled: false,
        reason: `saved, but ${TOOL_LABEL[firstTool]}'s environment could not recall it`,
      })
    } finally {
      await session.close()
    }

    // Recall from remaining launches
    for (let i = 1; i < opts.launches.length; i++) {
      const { tool, launch } = opts.launches[i]
      let s
      try {
        s = await openMcpSession(launch, { cwd: neutralCwd, timeoutMs: timeout })
      } catch {
        perTool.push({
          tool,
          recalled: false,
          reason: `saved, but ${TOOL_LABEL[tool]}'s environment could not recall it`,
        })
        continue
      }
      try {
        const recallResult = (await s.callTool('plur_recall', recallArgs)) as RecallResult
        await s.close()
        const recalled = recallResult?.results?.some((r) => r.id === savedId) ?? false
        if (recalled) {
          perTool.push({ tool, recalled: true })
        } else {
          perTool.push({
            tool,
            recalled: false,
            reason: `saved, but ${TOOL_LABEL[tool]}'s environment could not recall it`,
          })
        }
      } catch {
        await s.close().catch(() => undefined)
        perTool.push({
          tool,
          recalled: false,
          reason: `saved, but ${TOOL_LABEL[tool]}'s environment could not recall it`,
        })
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
