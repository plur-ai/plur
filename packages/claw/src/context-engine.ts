import { Plur } from '@plur-ai/core'
import type {
  ContextEngine, ContextEngineInfo, AssembleResult, IngestResult,
  CompactResult, BootstrapResult, SubagentSpawnPreparation, SubagentEndReason,
  AgentMessage,
} from './types.js'
import { extractLearnings, isCorrection } from './learner.js'
import { assembleContext } from './assembler.js'

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
    version: '0.1.0',
    ownsCompaction: false,
  }

  public readonly plur: Plur
  private options: PlurContextEngineOptions
  private sessionScopes = new Map<string, string>() // sessionKey → scope
  private sessionMessages = new Map<string, AgentMessage[]>() // track messages per session for afterTurn

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
    // Store scope from sessionKey if available (e.g., "user:john:agent:helper")
    if (params.sessionKey) {
      this.sessionScopes.set(params.sessionKey, `session:${params.sessionKey}`)
    }
    return { bootstrapped: true, reason: 'PLUR memory loaded' }
  }

  /** Ingest: process each message for real-time corrections */
  async ingest(params: {
    sessionId: string
    sessionKey?: string
    message: AgentMessage
    isHeartbeat?: boolean
  }): Promise<IngestResult> {
    if (params.isHeartbeat) return { ingested: false }

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
          this.plur.learn(candidate.statement, {
            type: candidate.type,
            scope: this.sessionScopes.get(params.sessionKey || '') || 'global',
            source: 'openclaw:ingest',
          })
        }
      }
    }

    return { ingested: true }
  }

  /** Assemble: build context with injected engrams */
  async assemble(params: {
    sessionId: string
    sessionKey?: string
    messages: AgentMessage[]
    tokenBudget?: number
  }): Promise<AssembleResult> {
    // Get the task context from the most recent user message
    const lastUserMsg = [...params.messages].reverse().find(m => m.role === 'user')
    const task = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '') : ''

    // Inject relevant engrams
    let injection = null
    if (task) {
      const scope = this.sessionScopes.get(params.sessionKey || '') || undefined
      injection = this.plur.inject(task, {
        budget: this.options.injection_budget,
        scope,
      })
    }

    return assembleContext({
      messages: params.messages,
      injection,
      tokenBudget: params.tokenBudget,
    })
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
    // During compaction, extract any learnings from the accumulated messages
    const key = params.sessionKey || params.sessionId
    const messages = this.sessionMessages.get(key) || []

    if (this.options.auto_learn && messages.length > 0) {
      const learnings = extractLearnings(messages)
      for (const candidate of learnings) {
        if (candidate.confidence >= 0.6) {
          this.plur.learn(candidate.statement, {
            type: candidate.type,
            scope: this.sessionScopes.get(params.sessionKey || '') || 'global',
            source: 'openclaw:compact',
          })
        }
      }
    }

    return {
      ok: true,
      compacted: false, // we don't own compaction
      reason: 'PLUR extracted learnings before compaction',
    }
  }

  /** AfterTurn: extract learnings and capture episodic summary */
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

    // Get new messages from this turn (after prePromptMessageCount)
    const newMessages = params.messages.slice(params.prePromptMessageCount)

    // Extract learnings from new messages (lower confidence threshold since full turn)
    if (this.options.auto_learn && newMessages.length > 0) {
      const learnings = extractLearnings(newMessages)
      for (const candidate of learnings) {
        if (candidate.confidence >= 0.5) {
          this.plur.learn(candidate.statement, {
            type: candidate.type,
            scope: this.sessionScopes.get(params.sessionKey || '') || 'global',
            source: 'openclaw:afterTurn',
          })
        }
      }
    }

    // Episodic capture — summarize what happened
    if (this.options.auto_capture && newMessages.length > 0) {
      const lastAssistant = [...newMessages].reverse().find(m => m.role === 'assistant')
      if (lastAssistant) {
        const summary = typeof lastAssistant.content === 'string'
          ? lastAssistant.content.slice(0, 200)
          : 'Turn completed'
        this.plur.capture(summary, {
          agent: 'openclaw',
          session_id: params.sessionId,
        })
      }
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
  }

  /** Dispose: clean up */
  async dispose(): Promise<void> {
    this.sessionScopes.clear()
    this.sessionMessages.clear()
  }

  // Helper for tests
  getSessionScope(sessionKey: string): string | undefined {
    return this.sessionScopes.get(sessionKey)
  }
}
