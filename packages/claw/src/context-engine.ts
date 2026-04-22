import { Plur } from '@plur-ai/core'
import type { LearnContext } from '@plur-ai/core'
import type {
  ContextEngine, ContextEngineInfo, AssembleResult, IngestResult,
  CompactResult, BootstrapResult, SubagentSpawnPreparation, SubagentEndReason,
  AgentMessage,
} from './types.js'
import { extractLearnings, isCorrection } from './learner.js'
import { assembleContext } from './assembler.js'

/**
 * Extract text from message content — handles string and array-of-blocks formats.
 */
function extractMessageText(message: AgentMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
  }
  return ''
}

/**
 * Extract self-reported learnings from assistant message.
 * Looks for the 🧠 I learned: section and parses bullet points.
 */
function extractSelfReportedLearnings(message: AgentMessage): string[] {
  const content = extractMessageText(message)
  // Match the learning section: ---\n🧠 I learned:\n- item\n- item
  const match = content.match(/---\s*\n🧠 I learned:\s*\n([\s\S]*?)(?:\n---|\n\n[^-]|$)/)
  if (!match) return []

  return match[1]
    .split('\n')
    .map(line => line.replace(/^[-•*]\s*/, '').trim())
    .filter(line => line.length >= 10) // skip empty or trivial lines
}

export interface PlurContextEngineOptions {
  path?: string
  auto_learn?: boolean
  auto_capture?: boolean
  injection_budget?: number
}

export class PlurContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'plur-claw',
    name: 'PLUR Memory Engine',
    version: '0.9.2',
    ownsCompaction: false,
  }

  public readonly plur: Plur
  private options: PlurContextEngineOptions
  private sessionScopes = new Map<string, string>() // sessionKey → scope
  private sessionMessages = new Map<string, AgentMessage[]>() // track messages per session for afterTurn
  private sessionLearned = new Map<string, Set<string>>() // track learned statements per session to prevent duplicates

  constructor(options?: PlurContextEngineOptions) {
    this.options = {
      auto_learn: true,
      auto_capture: true,
      injection_budget: 2000,
      ...options,
    }
    this.plur = new Plur({ path: options?.path })
  }

  /** Bootstrap: inject relevant engrams for the session */
  async bootstrap(params: {
    sessionId: string
    sessionKey?: string
    sessionFile: string
  }): Promise<BootstrapResult> {
    try {
      // Store scope from sessionKey if available (e.g., "user:john:agent:helper")
      if (params.sessionKey) {
        this.sessionScopes.set(params.sessionKey, `session:${params.sessionKey}`)
      }
      return { bootstrapped: true, reason: 'PLUR memory loaded' }
    } catch (err) {
      console.error('[plur-claw] bootstrap error:', err)
      return { bootstrapped: false, reason: `PLUR bootstrap failed: ${err}` }
    }
  }

  /** Ingest: process each message for real-time corrections */
  async ingest(params: {
    sessionId: string
    sessionKey?: string
    message: AgentMessage
    isHeartbeat?: boolean
  }): Promise<IngestResult> {
    if (params.isHeartbeat) return { ingested: false }

    try {
      // Track messages for afterTurn
      const key = params.sessionKey || params.sessionId
      if (!this.sessionMessages.has(key)) {
        this.sessionMessages.set(key, [])
      }
      this.sessionMessages.get(key)!.push(params.message)

      // Real-time correction detection
      if (this.options.auto_learn && isCorrection(params.message)) {
        const learnings = extractLearnings([params.message])
        for (const candidate of learnings) {
          if (candidate.confidence >= 0.7) {
            this._learnIfNew(key, candidate.statement, {
              type: candidate.type,
              scope: this.sessionScopes.get(params.sessionKey || '') || 'global',
              source: 'openclaw:ingest',
              rationale: 'user correction detected in real-time',
              tags: [candidate.type],
            })
          }
        }
      }

      return { ingested: true }
    } catch (err) {
      console.error('[plur-claw] ingest error:', err)
      return { ingested: false }
    }
  }

  /** Assemble: build context with injected engrams */
  async assemble(params: {
    sessionId: string
    sessionKey?: string
    messages: AgentMessage[]
    tokenBudget?: number
  }): Promise<AssembleResult> {
    try {
      // Get the task context from the most recent user message
      const lastUserMsg = [...params.messages].reverse().find(m => m.role === 'user')
      const task = lastUserMsg ? extractMessageText(lastUserMsg) : ''

      // Inject relevant engrams (hybrid: BM25 + embeddings when available)
      let injection = null
      if (task) {
        const scope = this.sessionScopes.get(params.sessionKey || '') || undefined
        const injectOpts = {
          budget: this.options.injection_budget,
          scope,
        }
        try {
          injection = await this.plur.injectHybrid(task, injectOpts)
        } catch {
          // Fall back to BM25 when embeddings unavailable
          injection = this.plur.inject(task, injectOpts)
        }
      }

      return assembleContext({
        messages: params.messages,
        injection,
        tokenBudget: params.tokenBudget,
      })
    } catch (err) {
      console.error('[plur-claw] assemble error:', err)
      // Return messages unchanged on error
      return {
        messages: params.messages,
        estimatedTokens: 0,
      }
    }
  }

  /** Compact: extract learnings from context being compacted */
  async compact(params: {
    sessionId: string
    sessionKey?: string
    sessionFile: string
    tokenBudget?: number
    force?: boolean
    currentTokenCount?: number
  }): Promise<CompactResult> {
    try {
      // During compaction, extract any learnings from the accumulated messages
      const key = params.sessionKey || params.sessionId
      const messages = this.sessionMessages.get(key) || []

      if (this.options.auto_learn && messages.length > 0) {
        const learnings = extractLearnings(messages)
        for (const candidate of learnings) {
          if (candidate.confidence >= 0.7) {
            this._learnIfNew(key, candidate.statement, {
              type: candidate.type,
              scope: this.sessionScopes.get(params.sessionKey || '') || 'global',
              source: 'openclaw:compact',
              rationale: 'extracted during context compaction',
              tags: [candidate.type],
            })
          }
        }
      }

      return {
        ok: true,
        compacted: false, // we don't own compaction
        reason: 'PLUR extracted learnings before compaction',
      }
    } catch (err) {
      console.error('[plur-claw] compact error:', err)
      return { ok: true, compacted: false, reason: `PLUR compact error: ${err}` }
    }
  }

  /** AfterTurn: extract learnings from LLM self-report + regex fallback, capture episode */
  async afterTurn(params: {
    sessionId: string
    sessionKey?: string
    sessionFile: string
    messages: AgentMessage[]
    prePromptMessageCount: number
    autoCompactionSummary?: string
    isHeartbeat?: boolean
    tokenBudget?: number
  }): Promise<void> {
    if (params.isHeartbeat) return

    try {
      const newMessages = params.messages.slice(params.prePromptMessageCount)
      const key = params.sessionKey || params.sessionId
      const scope = this.sessionScopes.get(params.sessionKey || '') || 'global'

      if (this.options.auto_learn && newMessages.length > 0) {
        // Primary: LLM self-reported learnings from 🧠 section in assistant response
        const lastAssistant = [...newMessages].reverse().find(m => m.role === 'assistant')
        if (lastAssistant) {
          const selfReported = extractSelfReportedLearnings(lastAssistant)
          for (const statement of selfReported) {
            this._learnIfNew(key, statement, {
              type: 'behavioral',
              scope,
              source: 'openclaw:self-report',
              rationale: 'self-reported by agent via learning section',
              tags: ['self-report'],
            })
          }
        }

        // Fallback: regex extraction from user messages (catches what LLM missed)
        const learnings = extractLearnings(newMessages)
        for (const candidate of learnings) {
          if (candidate.confidence >= 0.7) {
            this._learnIfNew(key, candidate.statement, {
              type: candidate.type,
              scope,
              source: 'openclaw:afterTurn',
              rationale: 'extracted from conversation via pattern matching',
              tags: [candidate.type],
            })
          }
        }
      }

      // Episodic capture — summarize what happened
      if (this.options.auto_capture && newMessages.length > 0) {
        const lastAssistant = [...newMessages].reverse().find(m => m.role === 'assistant')
        if (lastAssistant) {
          const content = extractMessageText(lastAssistant)
          // Strip the learning section from the episodic summary
          const summary = content.replace(/---\s*\n🧠 I learned:[\s\S]*$/, '').trim().slice(0, 200) || 'Turn completed'
          this.plur.capture(summary, {
            agent: 'openclaw',
            session_id: params.sessionId,
          })
        }
      }

      // Clean up session messages after processing to prevent memory leak
      this.sessionMessages.delete(key)
    } catch (err) {
      console.error('[plur-claw] afterTurn error:', err)
    }
  }

  /** PrepareSubagentSpawn: inject scoped engrams for child agent */
  async prepareSubagentSpawn(params: {
    parentSessionKey: string
    childSessionKey: string
    ttlMs?: number
  }): Promise<SubagentSpawnPreparation | undefined> {
    // Inherit parent scope for the child session
    const parentScope = this.sessionScopes.get(params.parentSessionKey)
    if (parentScope) {
      this.sessionScopes.set(params.childSessionKey, parentScope)
    }
    return {
      rollback: () => {
        this.sessionScopes.delete(params.childSessionKey)
      },
    }
  }

  /** OnSubagentEnded: absorb child learnings */
  async onSubagentEnded(params: {
    childSessionKey: string
    reason: SubagentEndReason
  }): Promise<void> {
    // Clean up child session state
    this.sessionScopes.delete(params.childSessionKey)
    this.sessionMessages.delete(params.childSessionKey)
    this.sessionLearned.delete(params.childSessionKey)
  }

  /** Dispose: clean up */
  async dispose(): Promise<void> {
    this.sessionScopes.clear()
    this.sessionMessages.clear()
    this.sessionLearned.clear()
  }

  // Helper for tests
  getSessionScope(sessionKey: string): string | undefined {
    return this.sessionScopes.get(sessionKey)
  }

  /** Learn a statement only if it hasn't been learned in this session already (prevents triple-learning). */
  private _learnIfNew(sessionKey: string, statement: string, context: LearnContext): void {
    if (!this.sessionLearned.has(sessionKey)) {
      this.sessionLearned.set(sessionKey, new Set())
    }
    const seen = this.sessionLearned.get(sessionKey)!
    const key = statement.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    this.plur.learn(statement, context)
  }
}
