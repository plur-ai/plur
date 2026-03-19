import type { OpenClawPluginDefinition, OpenClawPluginApi, ContextEngine, AssembleResult, IngestResult, CompactResult, BootstrapResult } from './types.js'

class PlurHelloEngine implements ContextEngine {
  readonly info = {
    id: 'plur-claw',
    name: 'PLUR Memory Engine',
    version: '0.1.0',
    ownsCompaction: false, // let OpenClaw handle compaction for now
  }

  async bootstrap(params: { sessionId: string; sessionKey?: string; sessionFile: string }): Promise<BootstrapResult> {
    console.error(`[plur] bootstrap: session=${params.sessionId}`)
    return { bootstrapped: true, reason: 'PLUR hello world' }
  }

  async ingest(params: { sessionId: string; message: { role: string; content: string } }): Promise<IngestResult> {
    console.error(`[plur] ingest: role=${params.message.role}, len=${params.message.content.length}`)
    return { ingested: true }
  }

  async assemble(params: { sessionId: string; messages: { role: string; content: string }[]; tokenBudget?: number }): Promise<AssembleResult> {
    const tokens = params.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
    return {
      messages: params.messages,
      estimatedTokens: tokens,
      systemPromptAddition: '[PLUR] Hello from PLUR Memory Engine! This is a validation build.',
    }
  }

  async compact(params: { sessionId: string; sessionFile: string; tokenBudget?: number }): Promise<CompactResult> {
    console.error(`[plur] compact: session=${params.sessionId}`)
    return { ok: true, compacted: false, reason: 'PLUR hello world — no compaction' }
  }
}

const plugin: OpenClawPluginDefinition = {
  id: 'plur-claw',
  name: 'PLUR Memory Engine',
  version: '0.1.0',
  kind: 'context-engine',

  register(api: OpenClawPluginApi) {
    api.registerContextEngine('plur-claw', () => new PlurHelloEngine())
  },
}

export default plugin
export { PlurHelloEngine }
export type { ContextEngine, AssembleResult, IngestResult, CompactResult, BootstrapResult, AgentMessage, OpenClawPluginApi, OpenClawPluginDefinition } from './types.js'
