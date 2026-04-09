import { existsSync, writeFileSync, readFileSync, mkdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { createPlur, type GlobalFlags } from '../plur.js'

/**
 * plur hook-inject — Claude Code hook for engram injection + auto session start.
 *
 * Called by UserPromptSubmit hook. First call:
 *   1. Creates a session ID (auto session start — no need for explicit plur_session_start)
 *   2. Reads .plur.yaml for project-level domain/scope defaults
 *   3. Injects relevant engrams based on the user's prompt
 *
 * Subsequent calls check if a reminder is due (every 10 min).
 *
 * With --rehydrate: always injects (used by PostCompact hook after context
 * compaction to restore engrams that were lost).
 *
 * With --event <type>: contextual injection for specific tool events:
 *   --event plan_mode   Full engram injection when entering plan mode
 *   --event skill       Domain-specific engrams based on skill name
 *   --event agent       Agent-scoped engrams for spawned agent
 *   --event subagent    Inject agent-scoped engrams into subagent context
 *
 * Input: JSON on stdin (Claude Code hook format: {prompt, ...} or {compact_summary, ...})
 * Output: JSON on stdout with {additionalContext} or empty (exit 0)
 */

const REMINDER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

interface ProjectConfig {
  domain?: string
  scope?: string
}

/**
 * Read .plur.yaml from cwd for project-level defaults.
 * Returns {} if not found or unparseable.
 */
function readProjectConfig(): ProjectConfig {
  const configPath = join(process.cwd(), '.plur.yaml')
  if (!existsSync(configPath)) return {}
  try {
    const content = readFileSync(configPath, 'utf8')
    const config: ProjectConfig = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed) continue
      const [key, ...rest] = trimmed.split(':')
      const value = rest.join(':').trim()
      if (key === 'domain') config.domain = value
      if (key === 'scope') config.scope = value
    }
    return config
  } catch {
    return {}
  }
}

function sessionDir(): string {
  const dir = join(tmpdir(), 'plur-sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sessionMarkerPath(): string {
  const ppid = process.ppid || 'unknown'
  return join(sessionDir(), `${ppid}.marker`)
}

function lastReminderPath(): string {
  const ppid = process.ppid || 'unknown'
  return join(sessionDir(), `${ppid}.reminded`)
}

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

function isReminderDue(): boolean {
  const path = lastReminderPath()
  try {
    const stat = statSync(path)
    return Date.now() - stat.mtimeMs > REMINDER_INTERVAL_MS
  } catch {
    // File doesn't exist = never reminded = due
    return true
  }
}

function touchReminder(): void {
  writeFileSync(lastReminderPath(), String(Date.now()))
}

function extractEventTask(input: Record<string, unknown>, event: string): string {
  // Extract contextual task description based on event type
  const toolInput = input.tool_input as Record<string, unknown> | undefined

  switch (event) {
    case 'plan_mode':
      // Entering plan mode — inject broadly relevant engrams
      return (input.prompt as string) || 'implementation planning and architecture'

    case 'skill': {
      // Skill invocation — inject domain-specific engrams
      const skillName = String(toolInput?.skill ?? input.tool_name ?? '')
      return skillName ? `skill: ${skillName}` : 'skill invocation'
    }

    case 'agent': {
      // Agent spawn — inject agent-scoped engrams
      const agentType = String(toolInput?.subagent_type ?? toolInput?.description ?? '')
      const agentPrompt = String(toolInput?.prompt ?? '').slice(0, 200)
      return agentType ? `agent: ${agentType} ${agentPrompt}` : agentPrompt || 'agent task'
    }

    case 'subagent': {
      // Subagent start — similar to agent but for SubagentStart event
      const desc = String(toolInput?.description ?? input.agent_name ?? '')
      return desc ? `subagent: ${desc}` : 'subagent task'
    }

    default:
      return ''
  }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const isRehydrate = args.includes('--rehydrate')
  const eventIdx = args.indexOf('--event')
  const event = eventIdx >= 0 ? args[eventIdx + 1] : null
  const marker = sessionMarkerPath()

  // Contextual injection for specific events (plan_mode, skill, agent, subagent)
  if (event) {
    const input = readStdinSync()
    const task = extractEventTask(input, event)
    if (!task) {
      // Passthrough — nothing to inject for
      process.stdout.write(JSON.stringify(input))
      return
    }

    const plur = createPlur(flags)
    const label = `[PLUR Memory — ${event}]`

    try {
      const result = await plur.injectHybrid(task, { budget: 3000 })
      if (result.count > 0) {
        const parts: string[] = []
        if (result.directives) parts.push(result.directives)
        if (result.constraints) parts.push(result.constraints)
        if (result.consider) parts.push(result.consider)
        const output = { additionalContext: `${label} ${result.count} engrams\n\n${parts.join('\n')}` }
        process.stdout.write(JSON.stringify(output))
        return
      }
    } catch {
      // Fall back to BM25
      const result = plur.inject(task, { budget: 3000 })
      if (result.count > 0) {
        const parts: string[] = []
        if (result.directives) parts.push(result.directives)
        if (result.constraints) parts.push(result.constraints)
        if (result.consider) parts.push(result.consider)
        const output = { additionalContext: `${label} ${result.count} engrams\n\n${parts.join('\n')}` }
        process.stdout.write(JSON.stringify(output))
        return
      }
    }
    return
  }

  // Session already started — check if periodic reminder is due
  if (!isRehydrate && existsSync(marker)) {
    if (isReminderDue()) {
      touchReminder()
      const projectConfig = readProjectConfig()
      const scopeHint = projectConfig.scope ? ` Use scope "${projectConfig.scope}" for plur_learn calls in this project.` : ''
      const output = {
        additionalContext: `[PLUR Memory Reminder] If the user corrected you, stated a preference, or you discovered a pattern — call plur_learn now.${scopeHint} Call plur_session_end with engram_suggestions before the conversation ends.`,
      }
      process.stdout.write(JSON.stringify(output))
    }
    return
  }

  const input = readStdinSync()
  const projectConfig = readProjectConfig()

  // Get task description from hook input
  let task: string
  if (isRehydrate) {
    const summary = (input.compact_summary as string) || ''
    let original = ''
    try {
      const raw = readFileSync(marker, 'utf8')
      // Marker is JSON since 0.8.2 (was plain text before)
      try { original = JSON.parse(raw).task || raw } catch { original = raw }
    } catch {}
    task = original ? `${original} ${summary}` : summary || 'general context rehydration'
  } else {
    task = (input.prompt as string) || ''
    if (!task) {
      writeFileSync(marker, '')
      return
    }
    // Auto session start: generate session ID and save with task
    const sessionId = randomUUID()
    writeFileSync(marker, JSON.stringify({ task, sessionId }))
    touchReminder() // Reset reminder timer on first message
  }

  // Inject engrams (with project scope if configured)
  const plur = createPlur(flags)
  const injectOpts = projectConfig.scope ? { scope: projectConfig.scope } : undefined
  let context: string | null = null
  let count = 0

  try {
    const result = await plur.injectHybrid(task, injectOpts)
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      context = parts.join('\n')
      count = result.count
    }
  } catch {
    // Fall back to BM25
    const result = plur.inject(task, injectOpts)
    if (result.count > 0) {
      const parts: string[] = []
      if (result.directives) parts.push(result.directives)
      if (result.constraints) parts.push(result.constraints)
      if (result.consider) parts.push(result.consider)
      context = parts.join('\n')
      count = result.count
    }
  }

  // Build session header
  const parts: string[] = []

  // Read back session info for the label
  let sessionId: string | undefined
  try {
    const markerData = JSON.parse(readFileSync(marker, 'utf8'))
    sessionId = markerData.sessionId
  } catch {}

  if (isRehydrate) {
    parts.push(`[PLUR Memory — rehydrated after compaction, ${count} engrams]`)
  } else {
    parts.push(`[PLUR Memory — session started, ${count} engrams injected]`)
    if (sessionId) parts.push(`Session ID: ${sessionId}`)
    if (projectConfig.domain) parts.push(`Project domain: ${projectConfig.domain}`)
    if (projectConfig.scope) parts.push(`Project scope: ${projectConfig.scope} — use this scope for plur_learn calls`)
  }

  if (context) {
    parts.push('')
    parts.push(context)
  }

  if (parts.length === 0) return

  const output = { additionalContext: parts.join('\n') }
  process.stdout.write(JSON.stringify(output))
}
