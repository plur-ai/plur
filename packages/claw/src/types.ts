// Local type definitions matching openclaw@2026.3.13 ContextEngine API
// These are re-declared locally so @plur-ai/claw works without openclaw installed

export interface AgentMessage {
  role: string
  content: string
  [key: string]: unknown
}

export interface ContextEngineInfo {
  id: string
  name: string
  version?: string
  ownsCompaction?: boolean
}

export interface BootstrapResult {
  bootstrapped: boolean
  importedMessages?: number
  reason?: string
}

export interface IngestResult {
  ingested: boolean
}

export interface AssembleResult {
  messages: AgentMessage[]
  estimatedTokens: number
  systemPromptAddition?: string
  injected_ids?: string[]
}

export interface CompactResult {
  ok: boolean
  compacted: boolean
  reason?: string
  result?: {
    summary?: string
    firstKeptEntryId?: string
    tokensBefore: number
    tokensAfter?: number
  }
}

export interface SubagentSpawnPreparation {
  rollback: () => void | Promise<void>
}

export type SubagentEndReason = 'deleted' | 'completed' | 'swept' | 'released'

export interface ContextEngine {
  readonly info: ContextEngineInfo
  bootstrap?(params: { sessionId: string; sessionKey?: string; sessionFile: string }): Promise<BootstrapResult>
  ingest(params: { sessionId: string; sessionKey?: string; message: AgentMessage; isHeartbeat?: boolean }): Promise<IngestResult>
  ingestBatch?(params: { sessionId: string; sessionKey?: string; messages: AgentMessage[]; isHeartbeat?: boolean }): Promise<{ ingested: boolean }>
  afterTurn?(params: { sessionId: string; sessionKey?: string; sessionFile: string; messages: AgentMessage[]; prePromptMessageCount: number; autoCompactionSummary?: string; isHeartbeat?: boolean; tokenBudget?: number }): Promise<void>
  assemble(params: { sessionId: string; sessionKey?: string; messages: AgentMessage[]; tokenBudget?: number }): Promise<AssembleResult>
  compact(params: { sessionId: string; sessionKey?: string; sessionFile: string; tokenBudget?: number; force?: boolean; currentTokenCount?: number }): Promise<CompactResult>
  prepareSubagentSpawn?(params: { parentSessionKey: string; childSessionKey: string; ttlMs?: number }): Promise<SubagentSpawnPreparation | undefined>
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>
  dispose?(): Promise<void>
}

export interface OpenClawPluginApi {
  registerContextEngine: (id: string, factory: () => ContextEngine | Promise<ContextEngine>) => void
}

export interface OpenClawPluginDefinition {
  id: string
  name: string
  version: string
  kind: 'memory' | 'context-engine'
  register(api: OpenClawPluginApi): void
}
