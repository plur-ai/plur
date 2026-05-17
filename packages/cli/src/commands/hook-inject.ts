import { existsSync, writeFileSync, readFileSync, mkdirSync, readSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir, homedir } from 'os'
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
  domain?:        string
  scope?:         string
  // Remote-Enterprise opt-in (per-project).
  // When set, the hook queries the remote /api/v1/inject before falling
  // back to local PLUR. Without these fields, the hook is local-only and
  // Enterprise never sees a query — personal/non-project prompts stay
  // private to the local engram store.
  remote_url?:    string   // e.g. https://plur.datafund.io
  remote_token?:  string   // API key (kept out of git via .gitignore)
  remote_scopes?: string[] // optional scope whitelist for the server query
}

/**
 * Walk upward from cwd looking for .plur.yaml. Stops at the home dir or
 * filesystem root so we don't accidentally pick up an unrelated config
 * from above the user's space.
 *
 * Matches the discovery pattern of .git, .envrc, tsconfig.json — lets the
 * user work from any subdirectory of an opted-in project without copying
 * the config everywhere.
 */
function findProjectConfigPath(startDir: string = process.cwd()): string | null {
  const home = homedir()
  let dir = startDir
  while (true) {
    const candidate = join(dir, '.plur.yaml')
    if (existsSync(candidate)) return candidate
    if (dir === home || dir === '/' || dir === '.') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Read .plur.yaml from the nearest enclosing project directory.
 * Returns {} if not found or unparseable.
 *
 * The parser is intentionally minimal (line-by-line) rather than pulling
 * js-yaml into @plur-ai/cli — config files are short, fields are flat,
 * and dependency-free keeps the CLI bundle tiny. Arrays use comma-
 * separated values OR YAML-style "- item" lines.
 */
function readProjectConfig(): ProjectConfig {
  const configPath = findProjectConfigPath()
  if (!configPath) return {}
  try {
    const content = readFileSync(configPath, 'utf8')
    const config: ProjectConfig = {}
    let inListKey: keyof ProjectConfig | null = null
    let listAcc: string[] = []
    const finishList = () => {
      if (inListKey === 'remote_scopes' && listAcc.length > 0) {
        config.remote_scopes = listAcc
      }
      inListKey = null
      listAcc = []
    }

    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed) continue

      // List continuation: "- item" lines belong to the previous key
      if (inListKey && trimmed.startsWith('-')) {
        listAcc.push(trimmed.slice(1).trim())
        continue
      }
      // Any non-list line ends the previous list
      if (inListKey) finishList()

      const colonIdx = trimmed.indexOf(':')
      if (colonIdx < 0) continue
      const key = trimmed.slice(0, colonIdx).trim()
      const value = trimmed.slice(colonIdx + 1).trim()

      switch (key) {
        case 'domain':       config.domain = value; break
        case 'scope':        config.scope = value; break
        case 'remote_url':   config.remote_url = value; break
        case 'remote_token': config.remote_token = value; break
        case 'remote_scopes':
          if (value === '' || value === '|') {
            // Multi-line YAML list follows — start accumulator
            inListKey = 'remote_scopes'
            listAcc = []
          } else {
            // Inline comma-separated form
            config.remote_scopes = value.split(',').map(s => s.trim()).filter(Boolean)
          }
          break
      }
    }
    finishList()
    return config
  } catch {
    return {}
  }
}

/**
 * POST to ${remote_url}/api/v1/inject — fire a fast HTTP injection.
 *
 * Returns the formatted context text on success, or null on any failure.
 * NEVER throws: hooks must degrade open or they break the user's prompt.
 * Timeout 2s — slow enough to allow real round trips, fast enough that a
 * dead server doesn't perceptibly delay every prompt.
 */
async function tryRemoteInject(
  config: ProjectConfig,
  task:   string,
): Promise<{ text: string; count: number; injectedIds: string[] } | null> {
  if (!config.remote_url || !config.remote_token) return null
  const base = config.remote_url.replace(/\/sse\/?$/, '').replace(/\/$/, '')
  const url  = `${base}/api/v1/inject`
  const body: Record<string, unknown> = { task }
  if (config.remote_scopes && config.remote_scopes.length > 0) {
    body.scopes = config.remote_scopes
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'authorization': `Bearer ${config.remote_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    clearTimeout(t)
    if (!r.ok) return null
    const data = await r.json() as { text?: string; count?: number; injected_ids?: string[] }
    if (!data.text || typeof data.text !== 'string') return null
    return {
      text:        data.text,
      count:       typeof data.count === 'number' ? data.count : 0,
      injectedIds: Array.isArray(data.injected_ids) ? data.injected_ids : [],
    }
  } catch {
    return null
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
    // Even with empty prompt, start a session and inject broadly
    if (!task) {
      task = 'general session'
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
  let remoteUsed = false

  // Remote-first when the project has opted in (.plur.yaml has remote_url +
  // remote_token). Personal/non-project sessions skip this entirely —
  // findProjectConfigPath returns null and the config is empty, so the
  // network call is never made. Privacy guarantee: prompts from a CWD
  // without a .plur.yaml never reach Enterprise.
  if (projectConfig.remote_url && projectConfig.remote_token) {
    const remote = await tryRemoteInject(projectConfig, task)
    if (remote && remote.count > 0) {
      context = remote.text
      count = remote.count
      remoteUsed = true
    }
    // If remote returned null or zero engrams, fall through to local so
    // the user still gets personal-store context.
  }

  if (!remoteUsed) {
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
  }

  // Build session header
  const parts: string[] = []

  // Read back session info for the label
  let sessionId: string | undefined
  try {
    const markerData = JSON.parse(readFileSync(marker, 'utf8'))
    sessionId = markerData.sessionId
  } catch {}

  const sourceLabel = remoteUsed ? ' (Enterprise)' : ''
  if (isRehydrate) {
    parts.push(`[PLUR Memory${sourceLabel} — rehydrated after compaction, ${count} engrams]`)
  } else {
    parts.push(`[PLUR Memory${sourceLabel} — session started, ${count} engrams injected]`)
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
