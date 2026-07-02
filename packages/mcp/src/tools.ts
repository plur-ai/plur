import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { Plur, extractMetaEngrams, validateMetaEngram, confidenceBand, generateProfile, getProfileForInjection, markProfileDirty, selectModelForOperation, readHistoryForEngram, getCachedUpdateCheck, minorVersionsBehind, scanForTensions, CapabilityCanary, readProjectConfig, isSharedScope, resolveRerankerName, getReranker, classifyRerankerFailure, hfCacheDirName } from '@plur-ai/core'
import type { LlmFunction, MetaField } from '@plur-ai/core'
import { recordTelemetry } from './telemetry.js'
import { VERSION } from './version.js'

/** Create an OpenAI-compatible LLM function from a base URL + API key */
function makeHttpLlm(baseUrl: string, apiKey: string, model: string = 'gpt-4o-mini'): LlmFunction {
  return async (prompt: string): Promise<string> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    })
    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`)
    }
    const data = await response.json() as any
    return data.choices?.[0]?.message?.content ?? ''
  }
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: ToolAnnotations
  handler: (args: Record<string, unknown>, plur: Plur) => Promise<unknown>
}

const PLUR_GUIDE_EMPTY = `## PLUR — Empty Store

You have **0 engrams**. This session's learnings will be lost unless you store them.

### What to store (call plur_learn):
- When the user corrects you ("no, use X not Y")
- When the user states a preference ("always do X", "never Y")
- When you discover a convention or pattern in the codebase
- Architecture decisions and their rationale

### Session workflow:
1. Work on your task
2. Call **plur_learn** whenever you encounter something worth remembering
3. Call **plur_session_end** before the conversation ends — suggest new engrams

The more you store now, the smarter you start next session.`

const PLUR_GUIDE = `## PLUR Quick Start

### Session Workflow
1. **plur_session_start** (you just called this) — context loaded
2. Work on your task
3. Call **plur_learn** when the user corrects you or states a preference
4. Call **plur_feedback** to rate which injected engrams helped
5. Call **plur_session_end** before the conversation ends — suggest new engrams

### Core Tools
- **plur_learn** — record corrections, preferences, patterns (CALL THIS OFTEN)
- **plur_recall_hybrid** — search engrams by topic
- **plur_forget** — retire an outdated engram`

function getLlmFunction(): LlmFunction | undefined {
  const openaiKey = process.env.OPENAI_API_KEY
  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (openrouterKey) return makeHttpLlm('https://openrouter.ai/api/v1', openrouterKey, 'openai/gpt-4o-mini')
  if (openaiKey) return makeHttpLlm('https://api.openai.com/v1', openaiKey, 'gpt-4o-mini')
  return undefined
}

/**
 * Strip XML parameter-envelope artifacts from a statement string.
 * When an LLM generates tool calls in the old XML format, the raw statement
 * value sometimes contains the closing tag followed by the full duplicated body:
 *   "clean text</statement>\n\n<parameter name="statement">clean text..."
 * Truncate at whichever marker appears first.
 */
function sanitizeStatement(raw: string): string {
  const markers = ['</statement>', '<parameter name=']
  let cut = raw.length
  for (const m of markers) {
    const pos = raw.indexOf(m)
    if (pos !== -1 && pos < cut) cut = pos
  }
  return raw.slice(0, cut).trimEnd()
}

// Exported so the server dispatch loop can tick it once per tool call (#192).
export const mcpCanary = new CapabilityCanary({ threshold: 10 })
mcpCanary.expect({
  id: 'session_start_hook',
  description: 'Automatic memory injection via hooks',
  fix: 'Run: npx @plur-ai/mcp init',
})
mcpCanary.expect({
  id: 'learn_activity',
  description: 'Learning from corrections',
  fix: 'Call plur_learn when corrected. If using hooks, verify they are installed.',
})

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'plur_learn',
      description:
        'Create an engram — record a reusable learning, preference, or correction. ' +
        'Multi-agent note: in an orchestration that spawns subagents, have the PARENT session own plur_learn writes — ' +
        'spawned subagents should return their findings as text for the parent to persist, rather than each calling ' +
        'plur_learn (tool availability is not guaranteed in every subagent context). See plur-ai/plur#281.',
      annotations: { title: 'Learn', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The knowledge assertion to store' },
          type: {
            type: 'string',
            enum: ['behavioral', 'terminological', 'procedural', 'architectural'],
            description: 'Category of the engram',
          },
          scope: { type: 'string', description: 'Namespace, e.g. global, project:myapp' },
          domain: { type: 'string', description: 'Domain tag, e.g. software.deployment' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Searchable keyword tags — contribute to BM25/embedding recall, so concrete keywords pay off' },
          rationale: { type: 'string', description: 'Why this knowledge matters — also enters the search corpus, helps recall by intent not just statement' },
          source: { type: 'string', description: 'Origin of this knowledge (URL, conversation ref, etc.)' },
          pinned: { type: 'boolean', description: 'Always-load flag. If true, this engram bypasses the keyword-relevance gate at injection time. Use sparingly: meta-rules, safety conventions, core operating principles only.' },
          commitment: { type: 'string', enum: ['exploring', 'leaning', 'decided', 'locked'], description: 'How firmly the user has committed to this belief (default: leaning)' },
          locked_reason: { type: 'string', description: 'Why this engram is locked (only meaningful when commitment=locked)' },
          valid_from: { type: 'string', description: 'ISO date (YYYY-MM-DD) the knowledge becomes valid — inject/recall skip the engram before this date (#347)' },
          valid_until: { type: 'string', description: 'ISO date (YYYY-MM-DD) the knowledge expires — inject/recall skip the engram after this date. Set this for any time-bound fact (offers, deadlines, temporary endpoints). When omitted, an explicit expiry phrase in the statement ("valid until 31 May 2026") is auto-parsed and echoed back (#347)' },
        },
        required: ['statement'],
      },
      handler: async (args, plur) => {
        const llm = getLlmFunction()
        // LLM-facing context. Fields not in inputSchema (visibility,
        // knowledge_anchors, dual_coding, abstract, derived_from, memory_class,
        // session_episode_id) stay in the engram spec and remain settable via
        // the Plur class / REST — just not asked of the LLM. Their feature
        // paths (private/public gating, meta-engram routing, etc.) are
        // unaffected. See plur-ai/plur#139.
        const context = {
          type: args.type as any,
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          source: args.source as string | undefined,
          tags: args.tags as string[] | undefined,
          rationale: args.rationale as string | undefined,
          commitment: args.commitment as any,
          locked_reason: args.locked_reason as string | undefined,
          pinned: args.pinned as boolean | undefined,
          valid_from: args.valid_from as string | undefined,
          valid_until: args.valid_until as string | undefined,
          llm,
        }
        // Route through learnRouted FIRST so remote-scope writes get
        // the server-assigned engram id (e.g. ENG-2026-05-06-007).
        // Without this, the caller sees a local placeholder id like
        // ENG-2026-0506-017 and any later forget(id)/feedback(id) call
        // against that placeholder fails — the engram only exists on
        // the server with the server's id. For local-scope writes,
        // learnRouted defers to sync learn() so dedup behavior is
        // unchanged. The handler is two-step (R2-D #17): learnRouted is
        // PRIMARY (try), and the synchronous learn() is a defense-in-depth
        // FALLBACK (catch) — learnAsync is NOT used on this path.
        // Runtime scope nudge (#296): when the caller passes no scope and the
        // engram lands at a PERSONAL scope ("local" or "global") WITHOUT being
        // auto-routed, while a team store IS configured, team knowledge silently
        // never reaches the shared store. Surface that at the moment it happens —
        // non-fatal, informational, and only when there is a team store to route
        // to (stays silent on personal installs). Un-scoped writes default to
        // "global" (the historical default, restored in 0.10.0, #353) and
        // auto-route on a confident covers match (stamping structured_data._routed).
        // The hint fires on ANY non-shared (personal-family) landing scope —
        // "local", "global", "user:*", "agent:*" — and stays silent when the
        // write was auto-routed or an explicit scope was passed.
        const explicitScope = typeof args.scope === 'string' && args.scope.length > 0
        const scopeHint = (engramScope: string, wasRouted: boolean): { scope_hint?: string } => {
          // isSharedScope swap (#353): fire on any non-shared landing scope, not
          // just the hardcoded {local,global} set, so a user:alice personal scope
          // also nudges when a team store is configured.
          if (explicitScope || wasRouted || isSharedScope(engramScope)) return {}
          let remote: Array<{ scope: string }> = []
          try { remote = plur.getWritableRemoteScopes() } catch { return {} }
          if (remote.length === 0) return {}
          const scopes = remote.map(s => `"${s.scope}"`).join(', ')
          return { scope_hint:
            `Stored at "${engramScope}" because no scope was passed, but a team store is configured (${scopes}). ` +
            `If this is team/engineering knowledge, re-learn it with an explicit scope so it reaches the shared ` +
            `store; keep genuinely personal notes at the default scope.` }
        }

        // Temporal validity echo (#347): report the stored window back, and
        // when valid_until was auto-extracted from the statement (not passed
        // by the caller), confirm the parse loudly — extraction must never
        // silently guess.
        const temporalEcho = (engram: { temporal?: { valid_from?: string; valid_until?: string } }) => {
          const extracted = (engram as any).structured_data?._expiry_extracted as { valid_until: string; phrase: string } | undefined
          return {
            ...(engram.temporal?.valid_from ? { valid_from: engram.temporal.valid_from } : {}),
            ...(engram.temporal?.valid_until ? { valid_until: engram.temporal.valid_until } : {}),
            ...(extracted ? { expiry_note: `Parsed expiry phrase "${extracted.phrase}" from the statement → temporal.valid_until=${extracted.valid_until}. The engram stops injecting/recalling after that date. If this is wrong, re-learn with an explicit valid_until.` } : {}),
          }
        }

        const statement = sanitizeStatement(args.statement as string)
        try {
          const engram = await plur.learnRouted(statement, context)
          const isOutbox = !!(engram as any).structured_data?._outbox
          const demoted = (engram as any).structured_data?._demoted as { from: string; to: string; patterns: string } | undefined
          const routed = (engram as any).structured_data?._routed as { scope: string; confidence: number; reason: string } | undefined
          mcpCanary.signal('learn_activity')
          // Opt-in, content-free engagement counter (default-off; no statement text).
          recordTelemetry('learn')
          return {
            id: engram.id, statement: engram.statement,
            scope: engram.scope, type: engram.type,
            pinned: (engram as any).pinned === true,
            decision: 'ADD',
            ...temporalEcho(engram),
            ...scopeHint(engram.scope, !!routed),
            ...(isOutbox ? { outbox: true, warning: 'Remote write failed; engram queued locally for retry on next session start or plur_sync.' } : {}),
            ...(demoted ? { demoted: true, requested_scope: demoted.from, warning: `Sensitive content (${demoted.patterns}) detected — stored at "${demoted.to}"/private instead of the requested shared scope "${demoted.from}". If this is a false positive, re-scope deliberately.` } : {}),
            ...(routed ? { routed: { scope: routed.scope, confidence: routed.confidence, reason: routed.reason }, info: `No scope was provided; auto-routed to "${routed.scope}" (confidence ${routed.confidence}) because its content matched that scope's covers. Pass an explicit scope to override.` } : {}),
          }
        } catch (err) {
// learnRouted now saves to outbox on remote failure, so this
          // path should rarely be reached. Keep as defense-in-depth.
          const engram = plur.learn(statement, context)
          const isOutbox = !!(engram as any).structured_data?._outbox
          const routedFallback = (engram as any).structured_data?._routed as { scope: string; confidence: number; reason: string } | undefined
          mcpCanary.signal('learn_activity')
          // Opt-in, content-free engagement counter (default-off; no statement text).
          recordTelemetry('learn')
          return {
            id: engram.id, statement: engram.statement,
            scope: engram.scope, type: engram.type, decision: 'ADD',
            ...temporalEcho(engram),
            ...scopeHint(engram.scope, !!routedFallback),
            ...(isOutbox ? { outbox: true } : {}),
            warning: `Remote write failed (${(err as Error).message}); engram queued for retry.`,
          }
        }
      },
    },

    {
      name: 'plur_recall',
      description: 'Query engrams by BM25 keyword matching — use plur_recall_hybrid for semantic similarity. Note: a project-scope filter also returns personal-family engrams (local, global, user:*, agent:*); an explicit scope=global recall returns ALL personal-family engrams — wider than scope=global INJECT, which is targeted to the global namespace only.',
      annotations: { title: 'Recall (BM25)', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant engrams' },
          scope: { type: 'string', description: 'Filter by scope (also includes global)' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          budget: { type: 'object', description: 'Budget constraints for sub-agents', properties: { max_tokens: { type: 'number' }, max_results: { type: 'number' } } },
          caller_session_id: { type: 'string', description: 'Caller session ID for budget enforcement' },
        },
        required: ['query'],
      },
      handler: async (args, plur) => {
        const results = plur.recall(args.query as string, {
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          limit: args.limit as number | undefined,
        })
        return {
          results: results.map(e => ({
            id: e.id,
            statement: e.statement,
            type: e.type,
            scope: e.scope,
            domain: e.domain,
            retrieval_strength: e.activation.retrieval_strength,
          })),
          count: results.length,
        }
      },
    },

    {
      name: 'plur_recall_hybrid',
      description: 'Hybrid search — BM25 + local embeddings merged via Reciprocal Rank Fusion. No API calls, fully local. Best default for most use cases.',
      annotations: { title: 'Recall (hybrid)', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant engrams' },
          scope: { type: 'string', description: 'Filter by scope (also includes global)' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          budget: { type: 'object', description: 'Budget constraints for sub-agents', properties: { max_tokens: { type: 'number' }, max_results: { type: 'number' }, ttl_seconds: { type: 'number' } } },
          caller_session_id: { type: 'string', description: 'Session ID of calling agent for budget enforcement' },
          include_episodes: { type: 'boolean', description: 'If true, include linked episode summaries for each engram (SP2 episodic anchoring)' },
        },
        required: ['query'],
      },
      handler: async (args, plur) => {
        const budget = args.budget as { max_tokens?: number; max_results?: number; ttl_seconds?: number } | undefined
        const effectiveLimit = budget?.max_results ?? (args.limit as number | undefined) ?? 20
        const meta = await plur.recallHybridWithMeta(args.query as string, {
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          limit: effectiveLimit,
        })
        // Opt-in, content-free engagement counter (default-off; no query text).
        recordTelemetry('recall')
        // Failed-recall miss-signal (WS5 demand flywheel) is emitted from the
        // core recallHybridWithMeta() this handler delegates to — it fires once
        // there for ALL consumers (MCP, claw, CLI, direct API), so we do NOT
        // re-emit here and double-count. It is opt-in/default-off and ships only
        // a query fingerprint hash + scope/domain + timestamp, never raw text.
        const results = meta.engrams
        let truncated = false
        let boundedResults = results
        if (budget?.max_results && results.length > budget.max_results) {
          boundedResults = results.slice(0, budget.max_results)
          truncated = true
        }
        if (budget?.max_tokens) {
          let tokenCount = 0
          const withinBudget = []
          for (const e of boundedResults) {
            const tokens = Math.ceil(e.statement.length / 4) + 20
            if (tokenCount + tokens > budget.max_tokens) { truncated = true; break }
            withinBudget.push(e)
            tokenCount += tokens
          }
          boundedResults = withinBudget
        }
        const includeEpisodes = args.include_episodes === true
        const response: Record<string, unknown> = {
          results: boundedResults.map(e => {
            const raw = e as any
            const base: Record<string, unknown> = {
              id: e.id,
              statement: e.statement,
              type: e.type,
              scope: e.scope,
              domain: e.domain,
              retrieval_strength: e.activation.retrieval_strength,
            }
            if (includeEpisodes && raw.episode_ids?.length > 0) {
              const episodes = plur.timeline({ search: '' })
              base.episodes = episodes
                .filter((ep: any) => raw.episode_ids.includes(ep.id))
                .map((ep: any) => ({ id: ep.id, summary: ep.summary, timestamp: ep.timestamp }))
            }
            return base
          }),
          count: boundedResults.length,
          truncated,
          mode: meta.mode,
        }
        if (meta.mode === 'hybrid-degraded') {
          response.warning = `Embedding layer unavailable — results are BM25-only. Run plur_doctor for diagnosis. Last error: ${meta.embedderError ?? 'unknown'}`
        }
        // #341: reranker non-engagement surfacing. When PLUR_RERANKER requests
        // reranking, report how many candidates the cross-encoder actually
        // re-scored — and if it never engaged on a non-empty result set, say
        // so in the response instead of a per-call stderr warning nobody
        // reads. The caller believes reranking is on; RRF-only results must
        // not be silently mislabeled.
        if (resolveRerankerName() !== 'off') {
          response.reranked = meta.reranked ?? 0
          const rr = plur.rerankerStatus()
          if (boundedResults.length > 0 && (meta.reranked ?? 0) === 0 && rr.lastError) {
            const corruptNote = rr.lastErrorKind === 'corrupt-cache'
              ? ' The model cache looks corrupt (truncated download) — purge and re-download, see plur_doctor.'
              : ''
            response.reranker_warning = `PLUR_RERANKER is set but the reranker did not engage — results are RRF-only (fusion order, no cross-encoder rerank).${corruptNote} Last error: ${rr.lastError}. Run plur_doctor for diagnosis.`
          }
        }
        return response
      },
    },

    {
      name: 'plur_inject',
      description: 'Get a scored context injection for a task — returns directives and considerations within token budget',
      annotations: { title: 'Inject (BM25)', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task description to inject context for' },
          budget: { type: 'number', description: 'Token budget for injection (default 2000)' },
          scope: { type: 'string', description: 'Scope filter for engram selection' },
        },
        required: ['task'],
      },
      handler: async (args, plur) => {
        const result = plur.inject(args.task as string, {
          budget: args.budget as number | undefined,
          scope: args.scope as string | undefined,
        })
        return {
          directives: result.directives,
          consider: result.consider,
          count: result.count,
          tokens_used: result.tokens_used,
          injected_ids: result.injected_ids,
        }
      },
    },

    {
      name: 'plur_inject_hybrid',
      description: 'Hybrid injection — BM25 + embeddings for better context selection. Falls back to BM25 if embeddings unavailable. Best default for injection.',
      annotations: { title: 'Inject (hybrid)', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task description to inject context for' },
          budget: { type: 'number', description: 'Token budget for injection (default 2000)' },
          scope: { type: 'string', description: 'Scope filter for engram selection' },
        },
        required: ['task'],
      },
      handler: async (args, plur) => {
        const result = await plur.injectHybrid(args.task as string, {
          budget: args.budget as number | undefined,
          scope: args.scope as string | undefined,
        })
        return {
          directives: result.directives,
          consider: result.consider,
          count: result.count,
          tokens_used: result.tokens_used,
          injected_ids: result.injected_ids,
          mode: 'hybrid',
        }
      },
    },

    {
      name: 'plur_feedback',
      description: 'Rate an engram\'s usefulness — trains injection relevance over time. Supports single or batch mode.',
      annotations: { title: 'Feedback', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Engram ID (single mode)' },
          signal: {
            type: 'string',
            enum: ['positive', 'negative', 'neutral'],
            description: 'Feedback signal (single mode)',
          },
          signals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Engram ID' },
                signal: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
              },
              required: ['id', 'signal'],
            },
            description: 'Batch feedback signals',
          },
        },
      },
      handler: async (args, plur) => {
        // Batch mode
        if (args.signals && Array.isArray(args.signals)) {
          const results: Array<{ id: string; signal: string; success: boolean; error?: string }> = []
          const summary = { positive: 0, negative: 0, neutral: 0 }
          for (const { id, signal } of args.signals as Array<{ id: string; signal: 'positive' | 'negative' | 'neutral' }>) {
            try {
              await plur.feedback(id, signal)
              results.push({ id, signal, success: true })
              summary[signal]++
            } catch (err: any) {
              results.push({ id, signal, success: false, error: err.message })
            }
          }
          return { mode: 'batch', results, summary }
        }
        // Single mode
        try {
          await plur.feedback(args.id as string, args.signal as 'positive' | 'negative' | 'neutral')
          return { success: true, id: args.id, signal: args.signal }
        } catch (err: any) {
          if (err.message?.includes('readonly store')) {
            return { success: false, id: args.id, signal: args.signal, note: 'Engram is in a readonly store. Feedback noted for this session but not persisted.' }
          }
          throw err
        }
      },
    },

    {
      name: 'plur_pin',
      description: 'Toggle the always-load (pinned) flag on an engram. Pinned engrams bypass the keyword-relevance gate at injection time and are eligible for loading on every session, regardless of overlap with the user task. Use sparingly — meta-rules, safety conventions, core operating principles. Pass {id, pinned:true} to pin or {id, pinned:false} to unpin. List current pinned with {list:true}.',
      annotations: { title: 'Pin', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Engram ID to pin or unpin' },
          pinned: { type: 'boolean', description: 'Target value (default true)' },
          list: { type: 'boolean', description: 'If true, just return the current set of pinned engrams (no mutation)' },
        },
      },
      handler: async (args, plur) => {
        if (args.list === true) {
          const pinned = plur.listPinned()
          return {
            count: pinned.length,
            pinned: pinned.map(e => ({ id: e.id, statement: e.statement, scope: e.scope, domain: e.domain })),
          }
        }
        if (!args.id) throw new Error('Provide id (or list:true to list pinned)')
        const target = (args.pinned as boolean | undefined) ?? true
        // Audit iter-1 fix (CTO): use async variant so remote pin operations
        // await the PATCH instead of returning an optimistic shell engram.
        // The sync setPinned() fire-and-forgets the remote PATCH and returns
        // a synthesized {id, pinned} object — caller observes stale state on
        // immediate getById. The async variant awaits and returns the real
        // server response.
        const updated = await plur.setPinnedAsync(args.id as string, target)
        if (!updated) throw new Error(`Engram not found: ${args.id}`)
        return {
          id: updated.id,
          statement: updated.statement,
          pinned: (updated as any).pinned === true,
        }
      },
    },

    {
      name: 'plur_forget',
      description: 'Retire an engram by ID or search term — marks it as no longer active without deleting history',
      annotations: { title: 'Forget', destructiveHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact engram ID to retire' },
          search: { type: 'string', description: 'Search term to find engram to retire' },
        },
      },
      handler: async (args, plur) => {
        if (args.id) {
          const engram = plur.getById(args.id as string)
          if (engram) {
            if (engram.status === 'retired') return { success: false, error: `Already retired: ${args.id}` }
            await plur.forget(args.id as string)
            return { success: true, retired: { id: engram.id, statement: engram.statement } }
          }
          // Not in local store — fall through to plur.forget() which routes to
          // remote stores (with prefix stripping per #86 / PR #186). Throws
          // "Engram not found" if it's nowhere.
          await plur.forget(args.id as string)
          return { success: true, retired: { id: args.id as string } }
        }
        if (args.search) {
          const matches = plur.recall(args.search as string, { limit: 100 })
          if (matches.length === 0) return { success: false, error: `No active engrams matching "${args.search}"` }
          if (matches.length === 1) {
            await plur.forget(matches[0].id)
            return { success: true, retired: { id: matches[0].id, statement: matches[0].statement } }
          }
          return {
            success: false,
            matches: matches.slice(0, 20).map(e => ({ id: e.id, statement: e.statement })),
            total: matches.length,
            error: `${matches.length} matches. Specify exact ID.`,
          }
        }
        throw new Error('Provide either id or search parameter')
      },
    },

    {
      name: 'plur_capture',
      description: 'Append an episode to the episodic timeline — records what happened in a session',
      annotations: { title: 'Capture episode', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What happened or was accomplished' },
          agent: { type: 'string', description: 'Agent identifier capturing this episode' },
          channel: { type: 'string', description: 'Communication channel (e.g. claude-code, chat)' },
          session_id: { type: 'string', description: 'Session identifier for grouping episodes' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorizing the episode',
          },
        },
        required: ['summary'],
      },
      handler: async (args, plur) => {
        const episode = plur.capture(args.summary as string, {
          agent: args.agent as string | undefined,
          channel: args.channel as string | undefined,
          session_id: args.session_id as string | undefined,
          tags: args.tags as string[] | undefined,
        })
        return { id: episode.id, summary: episode.summary, timestamp: episode.timestamp }
      },
    },

    {
      name: 'plur_timeline',
      description: 'Query the episodic timeline — retrieve past episodes filtered by time, agent, or search',
      annotations: { title: 'Timeline', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO date string — only episodes after this time' },
          until: { type: 'string', description: 'ISO date string — only episodes before this time' },
          agent: { type: 'string', description: 'Filter by agent identifier' },
          channel: { type: 'string', description: 'Filter by channel' },
          search: { type: 'string', description: 'Full-text search within episode summaries' },
        },
      },
      handler: async (args, plur) => {
        const query: Record<string, unknown> = {}
        if (args.since) query.since = new Date(args.since as string)
        if (args.until) query.until = new Date(args.until as string)
        if (args.agent) query.agent = args.agent
        if (args.channel) query.channel = args.channel
        if (args.search) query.search = args.search

        const episodes = plur.timeline(Object.keys(query).length > 0 ? query as any : undefined)
        return {
          episodes: episodes.map(e => ({
            id: e.id,
            summary: e.summary,
            timestamp: e.timestamp,
            agent: e.agent,
            channel: e.channel,
            tags: e.tags,
          })),
          count: episodes.length,
        }
      },
    },

    {
      name: 'plur_ingest',
      description: 'Extract engram candidates from content using pattern matching — optionally auto-save them',
      annotations: { title: 'Ingest', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Text content to extract learnings from' },
          source: { type: 'string', description: 'Source attribution for extracted engrams' },
          extract_only: {
            type: 'boolean',
            description: 'If true, return candidates without saving (default false — saves automatically)',
          },
          scope: { type: 'string', description: 'Scope to assign to saved engrams' },
          domain: { type: 'string', description: 'Domain to assign to saved engrams' },
        },
        required: ['content'],
      },
      handler: async (args, plur) => {
        const candidates = plur.ingest(args.content as string, {
          source: args.source as string | undefined,
          extract_only: args.extract_only as boolean | undefined,
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
        })
        return {
          candidates: candidates.map(c => ({
            statement: c.statement,
            type: c.type,
            source: c.source,
          })),
          count: candidates.length,
          saved: !(args.extract_only ?? false),
        }
      },
    },

    {
      name: 'plur_packs_preview',
      description: 'Preview a pack before installing — shows manifest, engram list, security scan, and warnings. Always call this before plur_packs_install to let the user review what they are importing.',
      annotations: { title: 'Preview pack', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Path to the pack directory to preview' },
        },
        required: ['source'],
      },
      handler: async (args, plur) => {
        return plur.previewPack(args.source as string)
      },
    },

    {
      name: 'plur_packs_install',
      description: 'Install an engram pack from a directory path. Runs a mandatory security scan (blocks if secrets found), detects conflicts with existing engrams, and records install metadata in the registry. Call plur_packs_preview first to show the user what the pack contains.',
      annotations: { title: 'Install pack', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Path to the pack directory to install' },
        },
        required: ['source'],
      },
      handler: async (args, plur) => {
        const result = plur.installPack(args.source as string)
        return {
          installed: result.installed,
          name: result.name,
          conflicts: result.conflicts,
          security: result.security,
          registry: result.registry,
          success: true,
        }
      },
    },

    {
      name: 'plur_packs_uninstall',
      description: 'Uninstall an engram pack by name — removes the pack and all its engrams',
      annotations: { title: 'Uninstall pack', destructiveHint: true, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Pack name to uninstall (use plur_packs_list to see names)' },
        },
        required: ['name'],
      },
      handler: async (args, plur) => {
        return plur.uninstallPack(args.name as string)
      },
    },

    {
      name: 'plur_packs_list',
      description: 'List all installed engram packs with integrity hashes, install dates, and source paths',
      annotations: { title: 'List packs', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_args, plur) => {
        const packs = plur.listPacks()
        return {
          packs: packs.map(p => ({
            name: p.name,
            version: p.manifest?.version,
            creator: p.manifest?.creator,
            description: p.manifest?.description,
            engram_count: p.engram_count,
            integrity: p.integrity,
            integrity_ok: p.integrity_ok,
            installed_at: p.installed_at,
            source: p.source,
          })),
          count: packs.length,
        }
      },
    },

    {
      name: 'plur_packs_discover',
      description: 'Browse available engram packs from the registry — discover curated expertise packs to install',
      annotations: { title: 'Discover packs', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to filter packs by name or description' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
          category: { type: 'string', description: 'Filter by category (e.g., devops, trading, writing)' },
        },
      },
      handler: async (args, plur) => {
        // TODO: Implement pack registry discovery
        // This will connect to a pack registry API (plur.ai/packs or GitHub-based)
        // For now, return a stub response
        return {
          packs: [],
          count: 0,
          message: 'Pack discovery coming soon. For now, install packs from local paths via plur_packs_install.',
        }
      },
    },

    {
      name: 'plur_sync',
      description: 'Sync engrams via git AND refresh the derived index from YAML. Initializes repo on first call, commits and pushes/pulls on subsequent calls. Provide a remote URL on first call to enable cross-device sync. Pass full=true to drop-and-rebuild the index from YAML (recovery path; YAML stays untouched).',
      annotations: { title: 'Sync', openWorldHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          remote: {
            type: 'string',
            description: 'Git remote URL (e.g. git@github.com:user/plur-engrams.git). Only needed on first call to set up remote.',
          },
          full: {
            type: 'boolean',
            description: 'Full reindex: drop the derived index (PGLite/SQLite) and rebuild from YAML. YAML is never modified. Use to recover from an out-of-sync index.',
          },
        },
      },
      handler: async (args, plur) => {
        const result = plur.sync(args.remote as string | undefined, { full: args.full === true })

        // #272: block on the background index/reembed chain and surface its
        // failure — the chain's .catch swallows the rejection, so without
        // this a failed index pass reported plain success.
        await plur.waitForIndex()
        const indexError = plur.lastIndexError()

        // Flush outbox after git sync (issue #26)
        let outbox_result: { flushed: number; failed: number; expired_warnings: string[] } | undefined
        try {
          outbox_result = await plur.flushOutbox()
        } catch { /* logged inside flushOutbox */ }

        return {
          ...result,
          ...(indexError ? {
            index_error: indexError,
            warning: `Index ${indexError.op} failed — ${indexError.message}. YAML is still the source of truth; run plur_sync with full=true to rebuild the index.`,
          } : {}),
          ...(outbox_result && (outbox_result.flushed > 0 || outbox_result.failed > 0) ? {
            outbox: {
              flushed: outbox_result.flushed,
              pending: outbox_result.failed,
              warnings: outbox_result.expired_warnings,
            },
          } : {}),
        }
      },
    },

    {
      name: 'plur_sync_status',
      description: 'Check git sync status — whether repo is initialized, has remote, is dirty, ahead/behind counts',
      annotations: { title: 'Sync status', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_args, plur) => {
        return plur.syncStatus()
      },
    },

    {
      name: 'plur_extract_meta',
      description: 'Extract meta-engrams from stored engrams using the 6-stage pipeline (structural analysis → clustering → alignment → formulation → hierarchy). Requires an LLM API endpoint.',
      annotations: { title: 'Extract meta-engrams', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          llm_base_url: { type: 'string', description: 'OpenAI-compatible API base URL (e.g. https://api.openai.com/v1)' },
          llm_api_key: { type: 'string', description: 'API key for the LLM' },
          llm_model: { type: 'string', description: 'Model name (default: gpt-4o-mini)' },
          domain: { type: 'string', description: 'Filter source engrams by domain prefix' },
          scope: { type: 'string', description: 'Filter source engrams by scope' },
          run_validation: { type: 'boolean', description: 'Whether to run cross-domain validation (default: false)' },
          dry_run: { type: 'boolean', description: 'If true, extract but do not persist meta-engrams (default: false)' },
        },
        required: ['llm_base_url', 'llm_api_key'],
      },
      handler: async (args, plur) => {
        const llm = makeHttpLlm(
          args.llm_base_url as string,
          args.llm_api_key as string,
          args.llm_model as string | undefined,
        )
        // Load all active engrams (list() returns all, no BM25 filter)
        const sourceEngrams = plur.list({
          domain: args.domain as string | undefined,
          scope: args.scope as string | undefined,
        })
        // Load existing meta-engrams for deduplication during pipeline
        const existingMetas = plur.list().filter(e => e.id.startsWith('META-'))
        const result = await extractMetaEngrams(sourceEngrams, llm, {
          run_validation: args.run_validation as boolean | undefined,
          existing_metas: existingMetas,
        })

        // Persist unless dry_run
        const isDryRun = args.dry_run === true
        let saveStats: { saved: number; skipped: number } | null = null
        if (!isDryRun && result.results.length > 0) {
          saveStats = plur.saveMetaEngrams(result.results)
        }

        return {
          engrams_analyzed: result.engrams_analyzed,
          clusters_found: result.clusters_found,
          alignments_passed: result.alignments_passed,
          meta_engrams_extracted: result.meta_engrams_extracted,
          rejected_as_platitudes: result.rejected_as_platitudes,
          duration_ms: result.duration_ms,
          dry_run: isDryRun,
          ...(saveStats ? { saved: saveStats.saved, skipped: saveStats.skipped } : {}),
          results: result.results.map(m => ({
            id: m.id,
            statement: m.statement,
            domain: m.domain,
            confidence: (m.structured_data?.meta as MetaField | undefined)?.confidence?.composite ?? 0,
            confidence_band: confidenceBand((m.structured_data?.meta as MetaField | undefined)?.confidence?.composite ?? 0),
            hierarchy_level: (m.structured_data?.meta as MetaField | undefined)?.hierarchy?.level ?? 'mop',
          })),
        }
      },
    },

    {
      name: 'plur_meta_engrams',
      description: 'List existing meta-engrams (engrams with META- prefix) with their structural templates and confidence scores',
      annotations: { title: 'List meta-engrams', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Filter by domain prefix (e.g. meta, meta.trading)' },
          min_confidence: { type: 'number', description: 'Minimum composite confidence score (0-1)' },
          hierarchy_level: { type: 'string', enum: ['mop', 'top'], description: 'Filter by hierarchy level' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
        },
      },
      handler: async (args, plur) => {
        const allEngrams = plur.list()
        const metaEngrams = allEngrams.filter(e => e.id.startsWith('META-'))
        const minConfidence = (args.min_confidence as number | undefined) ?? 0
        const levelFilter = args.hierarchy_level as string | undefined
        const domainFilter = args.domain as string | undefined
        const limit = (args.limit as number | undefined) ?? 20

        const filtered = metaEngrams
          .filter(m => {
            const mf = m.structured_data?.meta as MetaField | undefined
            if (!mf) return false
            if (mf.confidence?.composite < minConfidence) return false
            if (levelFilter && mf.hierarchy?.level !== levelFilter) return false
            if (domainFilter && !m.domain?.startsWith(domainFilter)) return false
            return true
          })
          .slice(0, limit)

        return {
          results: filtered.map(m => {
            const mf = m.structured_data?.meta as MetaField | undefined
            return {
              id: m.id,
              statement: m.statement,
              domain: m.domain,
              template: mf?.structure?.template,
              hierarchy_level: mf?.hierarchy?.level,
              confidence: mf?.confidence?.composite,
              confidence_band: confidenceBand(mf?.confidence?.composite ?? 0),
              evidence_count: mf?.confidence?.evidence_count,
              domain_count: mf?.confidence?.domain_count,
              validated_domains: mf?.domain_coverage?.validated,
            }
          }),
          count: filtered.length,
          total_meta_engrams: metaEngrams.length,
        }
      },
    },

    {
      name: 'plur_validate_meta',
      description: 'Test a meta-engram template against engrams from a new domain — updates confidence and domain_coverage',
      annotations: { title: 'Validate meta-engram', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          meta_engram_id: { type: 'string', description: 'META- engram ID to validate' },
          test_domain: { type: 'string', description: 'Domain to test against (e.g. medicine)' },
          llm_base_url: { type: 'string', description: 'OpenAI-compatible API base URL' },
          llm_api_key: { type: 'string', description: 'API key for the LLM' },
          llm_model: { type: 'string', description: 'Model name (default: gpt-4o-mini)' },
        },
        required: ['meta_engram_id', 'test_domain', 'llm_base_url', 'llm_api_key'],
      },
      handler: async (args, plur) => {
        const allEngrams = plur.list()
        const meta = allEngrams.find(e => e.id === (args.meta_engram_id as string))
        if (!meta) {
          throw new Error(`Meta-engram not found: ${args.meta_engram_id}`)
        }

        const testDomain = args.test_domain as string
        const testEngrams = plur.list({ domain: testDomain })

        const llm = makeHttpLlm(
          args.llm_base_url as string,
          args.llm_api_key as string,
          args.llm_model as string | undefined,
        )

        const result = await validateMetaEngram(meta, testEngrams, testDomain, llm)

        // validateMetaEngram mutates domain_coverage + confidence in-place — persist changes
        plur.updateEngram(meta)

        return {
          meta_engram_id: result.meta_engram_id,
          test_domain: result.test_domain,
          prediction_held: result.prediction_held,
          matching_engram_id: result.matching_engram_id,
          alignment_score: result.alignment_score,
          rationale: result.rationale,
          updated_confidence: (meta.structured_data?.meta as MetaField | undefined)?.confidence?.composite,
          updated_confidence_band: confidenceBand((meta.structured_data?.meta as MetaField | undefined)?.confidence?.composite ?? 0),
        }
      },
    },

    {
      name: 'plur_status',
      description: 'Return system health — running version, engram count, episode count, pack count, storage root',
      annotations: { title: 'Status', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_args, plur) => {
        const status = plur.status()
        const versionCheck = getCachedUpdateCheck('@plur-ai/mcp')
        return {
          version: VERSION,
          engram_count: status.engram_count,
          episode_count: status.episode_count,
          pack_count: status.pack_count,
          storage_root: status.storage_root,
          locked_count: status.locked_count,
          tension_count: status.tension_count,
          versioned_engram_count: status.versioned_engram_count ?? 0,
          outbox_count: status.outbox_count ?? 0,
          // Injection-provenance event/label counts (#452) — #202's volume gate.
          history_events: status.history_events ?? {
            co_injection: 0,
            injection_outcome: 0,
            outcome_positive: 0,
            outcome_negative: 0,
          },
          // Last background index/reembed failure (#272) — absent when healthy.
          ...(status.index_error ? { index_error: status.index_error } : {}),
          // Version check (issue #151)
          ...(versionCheck?.updateAvailable && versionCheck.latest ? {
            update_available: {
              current: versionCheck.current,
              latest: versionCheck.latest,
              behind: minorVersionsBehind(versionCheck.current, versionCheck.latest),
            },
          } : {}),
          capabilities: mcpCanary.status(),
        }
      },
    },

    {
      name: 'plur_doctor',
      description: 'Diagnose the PLUR install. Reports whether the embedding model loaded, whether hybrid search is fully operational, and — for any configured enterprise/remote store — whether its auth is valid (probes /api/v1/me and decodes token expiry), so a dead or soon-to-expire token surfaces instead of hiding behind a "healthy" report. Run this first when recall feels off or team engrams stop syncing.',
      annotations: { title: 'Doctor', readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          retry: { type: 'boolean', description: 'If true, reset cached embedder failure state and retry the model load before reporting' },
        },
      },
      handler: async (args, plur) => {
        if (args.retry === true) {
          plur.resetEmbedder()
          // #341: also reset reranker caches + failure tracker so a purged
          // corrupt model cache can be re-probed without a process restart.
          plur.resetReranker()
        }
        const status = plur.status()
        const before = plur.embedderStatus()
        // Skip the load probe when explicitly disabled — would short-circuit
        // anyway and pollute the report with a misleading "load attempt".
        if (!before.disabled) {
          try {
            await plur.recallSemantic('plur doctor probe', { limit: 1 })
          } catch {
            // ignore — probe is best-effort
          }
        }
        const after = plur.embedderStatus()
        const checks: Record<string, unknown>[] = []
        checks.push({
          check: 'engram store',
          ok: status.engram_count > 0,
          detail: `${status.engram_count} engrams across ${status.pack_count} packs at ${status.storage_root}`,
        })
        // When embeddings are explicitly disabled, mark the embedder check as
        // ok with a "disabled-on-purpose" detail. Hybrid search is then
        // expected to run BM25-only and that's a healthy state, not a fault.
        if (after.disabled) {
          checks.push({
            check: 'embedder available',
            ok: true,
            detail: `Disabled on purpose — ${after.disabledReason ?? 'embeddings disabled'}`,
          })
          checks.push({
            check: 'hybrid search operational',
            ok: true,
            detail: 'Running in BM25-only mode (embeddings opted out)',
          })
        } else {
          checks.push({
            check: 'embedder available',
            ok: after.available && after.loaded,
            detail: after.loaded
              ? 'BGE-small-en-v1.5 loaded'
              : after.lastError
              ? `Failed to load: ${after.lastError}`
              : 'Not yet loaded — first call may have raced; try again or use retry:true',
          })
          const hybridOk = after.available && after.loaded
          checks.push({
            check: 'hybrid search operational',
            ok: hybridOk,
            detail: hybridOk
              ? 'Hybrid search will use BM25 + embeddings (fully functional)'
              : 'Hybrid search will silently degrade to BM25-only — semantic recall disabled',
          })
        }
        const remediation: string[] = []
        if (!after.disabled && !(after.available && after.loaded)) {
          remediation.push(
            'Embedding model is not loaded. Common causes:',
            '  • First-run download not yet completed (try: plur_doctor with retry:true)',
            '  • Network blocked HuggingFace Hub fetch — check connectivity to huggingface.co',
            '  • pnpm hoisting issue: @huggingface/transformers must resolve onnxruntime-node from the package root, not a workspace package',
            '  • Corrupt model cache: a half-completed download leaves a broken cache that fails every subsequent load. Delete `~/.cache/huggingface/hub/models--Xenova--bge-small-en-v1.5/` and retry — the model will redownload on next call.',
            '  • Manual fix: from the @plur-ai/core package directory, run a script that imports @huggingface/transformers and calls pipeline() to trigger the download',
            '  • Or opt out: set PLUR_DISABLE_EMBEDDINGS=1, or write `embeddings: { enabled: false }` to ~/.plur/config.yaml — hybrid search will run BM25-only',
          )
        }
        // Reranker health (#341) — only when PLUR_RERANKER opts in; off (the
        // default) is healthy silence, not a check. The probe scores one pair
        // through the real adapter: per #220 that is seconds-scale on CPU
        // (plus a one-time model download on first run), which is acceptable
        // for an explicit doctor run and the only way to catch a corrupt
        // cache before recall silently degrades to RRF order.
        const rerankerName = resolveRerankerName()
        if (rerankerName !== 'off') {
          const adapter = getReranker(rerankerName)
          let rerankerOk = false
          let rerankerDetail: string
          const probeStart = Date.now()
          try {
            const scores = await adapter.scoreBatch('plur doctor probe', ['probe document'])
            rerankerOk = scores.length === 1 && Number.isFinite(scores[0])
            rerankerDetail = rerankerOk
              ? `${rerankerName} loaded and scoring (probe ${Date.now() - probeStart}ms; seconds-scale per recall on CPU is expected — #220)`
              : `Probe returned malformed scores (${JSON.stringify(scores)}) — recall silently falls back to RRF-only`
          } catch (err) {
            const message = (err as Error).message
            const kind = classifyRerankerFailure(message)
            if (kind === 'corrupt-cache') {
              rerankerDetail = `Model cache looks corrupt (${message}) — recall silently falls back to RRF-only`
              remediation.push(
                `Reranker model cache is corrupt — the classic symptom of a truncated download (#340). Delete ~/.cache/huggingface/hub/${hfCacheDirName(adapter.modelId)}/ and run plur_doctor with retry:true — the model will redownload via the classic (non-Xet) path.`,
              )
            } else {
              rerankerDetail = `Failed to load: ${message} — recall silently falls back to RRF-only`
              remediation.push(
                `Reranker "${rerankerName}" is unavailable while PLUR_RERANKER requests it — recall degrades to RRF order without it. Check connectivity to huggingface.co (first-run download), or unset PLUR_RERANKER to opt out deliberately.`,
              )
            }
          }
          checks.push({ check: 'reranker available', ok: rerankerOk, detail: rerankerDetail })
        }
        const canaryStatuses = mcpCanary.status()
        for (const cs of canaryStatuses) {
          if (!cs.healthy) {
            checks.push({ check: `capability: ${cs.capability}`, ok: false, detail: cs.warning })
            if (cs.warning) remediation.push(cs.warning)
          }
        }
        // Remote store auth/reachability (#295) — without this, doctor reports
        // "healthy" while the enterprise token is expired and writes silently
        // queue. Probe /me per configured remote and decode token expiry.
        try {
          const remotes = await plur.checkRemoteHealth({ timeoutMs: 5000 })
          for (const h of remotes) {
            const expiresNote = typeof h.tokenExpiresInDays === 'number'
              ? ` — token ${h.tokenExpiresInDays < 0 ? `expired ${-h.tokenExpiresInDays}d ago` : `expires in ${h.tokenExpiresInDays}d`}`
              : ''
            if (h.status === 'ok') {
              const soon = typeof h.tokenExpiresInDays === 'number' && h.tokenExpiresInDays <= 7
              checks.push({
                check: `remote store: ${h.url}`,
                ok: !soon,
                detail: soon
                  ? `Reachable, but token expires in ${h.tokenExpiresInDays}d — reauth soon`
                  : `Reachable, auth valid${expiresNote}`,
              })
              if (soon) remediation.push(`Remote ${h.url}: token expires in ${h.tokenExpiresInDays}d — mint a new token (<host>/me/api-keys), update ~/.plur/config.yaml, restart.`)
            } else if (h.status === 'auth_expired') {
              checks.push({ check: `remote store: ${h.url}`, ok: false, detail: `AUTH FAILED${expiresNote} — team-scoped writes are queuing to the outbox, not syncing. (${h.reason ?? ''})` })
              remediation.push(`Remote ${h.url}: re-authenticate — open <host>/auth/github (or <host>/me/api-keys) in a browser, paste the token into ~/.plur/config.yaml, then restart Claude/MCP so it reloads. Queued engrams flush on next session_start.`)
            } else {
              checks.push({ check: `remote store: ${h.url}`, ok: false, detail: `Unreachable (${h.reason ?? 'network error'}) — writes queue locally until it recovers.` })
              remediation.push(`Remote ${h.url}: unreachable — check connectivity/VPN. Reads fall back to local; writes queue in the outbox.`)
            }
          }
        } catch { /* best-effort — never let the remote probe break doctor */ }
        return {
          ok: checks.every(c => c.ok),
          checks,
          embedder: {
            before_probe: before,
            after_probe: after,
          },
          capabilities: canaryStatuses,
          remediation: remediation.length > 0 ? remediation : ['All checks passed — PLUR is healthy.'],
        }
      },
    },

    {
      name: 'plur_session_start',
      description: 'Start a session — inject relevant engrams for your task. Call at the beginning of every session.',
      annotations: { title: 'Session Start', readOnlyHint: true, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What you are working on (triggers engram injection)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags to filter injected engrams' },
          default_scope: { type: 'string', description: 'Default scope for plur_learn calls this session when no explicit scope is provided. Only set this if you want ALL engrams to route to a specific store. Usually, leave unset and pass scope per-engram based on relevance.' },
        },
        required: ['task'],
      },
      handler: async (args, plur) => {
        // #192: fresh canary window per session — health detection is
        // per-session, not per-process. Without this, a single learn_activity
        // signal kept the canary healthy for the whole server lifetime, and
        // ticks accumulated across sessions. Ticking now happens once per
        // tool call in the server dispatch loop.
        mcpCanary.reset()
        mcpCanary.signal('session_start_hook')
        const crypto = await import('crypto')
        const session_id = crypto.randomUUID()
        const task = args.task as string
        const tags = args.tags as string[] | undefined

        // Auto-discovery happens in Plur constructor — no manual call needed.

        // Flush outbox — retry pending remote writes (issue #26)
        let outbox_result: { flushed: number; failed: number; expired_warnings: string[] } | undefined
        try {
          outbox_result = await plur.flushOutbox()
        } catch { /* logged inside flushOutbox */ }

        // Surface writable remote scopes so AI caller knows what's available (#229)
        // NOTE: we do NOT auto-set session scope FROM REMOTE STORES — the AI
        // caller must judge per-engram whether it belongs on the enterprise
        // store or stays local. Auto-setting all engrams to remote would
        // route personal/project-local knowledge to the team store.
        //
        // #345/#346 (Stage 3a): enrich each writable scope with its
        // self-describing metadata (description + covers) so the AI caller can
        // see what each scope is FOR when deciding routing. Additive — the
        // existing { scope, url } shape is preserved; description/covers appear
        // only when the scope declares them.
        const remote_scopes = plur.getWritableRemoteScopes().map(s => {
          const md = plur.getScopeMetadata(s.scope)
          return {
            ...s,
            ...(md?.description ? { description: md.description } : {}),
            ...(md?.covers && md.covers.length > 0 ? { covers: md.covers } : {}),
          }
        })

        // Project scope detection (#177) — read .plur.yaml from the MCP
        // server's cwd. Walking stops at .git boundary and refuses
        // .plur.yaml in HOME (privacy guard from hook-inject). When the
        // project declares a scope, auto-apply it as the session default
        // UNLESS the caller explicitly passed a different default_scope.
        const projectConfig = readProjectConfig()
        const explicit_default_scope = (args.default_scope as string | undefined) ?? null
        const default_scope = explicit_default_scope ?? projectConfig.scope ?? null
        const scope_source = explicit_default_scope
          ? 'caller'
          : projectConfig.scope
            ? 'project-config'
            : 'none'

        // Always reset _sessionScope BEFORE possibly setting it. The MCP server
        // is one long-lived process serving many sequential session_start calls;
        // without this reset, a default_scope set in session A leaks into every
        // subsequent session that didn't pass its own default_scope.
        plur.setSessionScope(default_scope)

        // Get store stats for context
        const status = plur.status()
        const store_stats = {
          engram_count: status.engram_count,
          episode_count: status.episode_count,
          pack_count: status.pack_count,
        }

        // Warm remote store caches before injection (#235)
        // Ensures enterprise engrams are available for the first injectHybrid call.
        await plur.warmRemoteCaches().catch(() => {})

        // Inject relevant engrams
        let engrams: { text: string; count: number; injected_ids: string[] } | null = null
        try {
          const result = await plur.injectHybrid(task, {
            scope: tags?.length ? `tags:${tags.join(',')}` : undefined,
            session_id, // stamped on the co_injection provenance event (#452)
          })
          if (result.count > 0) {
            const lines: string[] = []
            if (result.directives) lines.push('## DIRECTIVES\n', result.directives)
            if (result.constraints) lines.push('\n## CONSTRAINTS\n', result.constraints)
            if (result.consider) lines.push('\n## ALSO CONSIDER\n', result.consider)
            engrams = { text: lines.join('\n'), count: result.count, injected_ids: result.injected_ids }
          }
        } catch {
          // Fall back to BM25 if hybrid unavailable
          const result = plur.inject(task, {
            scope: tags?.length ? `tags:${tags.join(',')}` : undefined,
            session_id,
          })
          if (result.count > 0) {
            const lines: string[] = []
            if (result.directives) lines.push('## DIRECTIVES\n', result.directives)
            if (result.constraints) lines.push('\n## CONSTRAINTS\n', result.constraints)
            if (result.consider) lines.push('\n## ALSO CONSIDER\n', result.consider)
            engrams = { text: lines.join('\n'), count: result.count, injected_ids: result.injected_ids }
          }
        }

        // Pick the right guide based on store state
        let guide: string
        if (engrams) {
          guide = `Session started with ${engrams.count} engrams from ${store_stats.engram_count} total. Remember to call plur_learn when corrected and plur_session_end before the conversation ends.`
        } else if (store_stats.engram_count === 0) {
          guide = PLUR_GUIDE_EMPTY
        } else {
          guide = `${PLUR_GUIDE}\n\nYou have ${store_stats.engram_count} engrams but none matched this task. Call plur_learn to capture new learnings from this session.`
        }

        // Detect fresh install: no engrams AND no episodes = never used before
        const isFreshInstall = store_stats.engram_count === 0 && store_stats.episode_count === 0

        // Version staleness check — zero-cost cache read (issue #151)
        const versionCheck = getCachedUpdateCheck('@plur-ai/mcp')
        let version_warning: string | undefined
        if (versionCheck?.updateAvailable && versionCheck.latest) {
          const behind = minorVersionsBehind(versionCheck.current, versionCheck.latest)
          if (behind > 2) {
            version_warning = `CRITICAL: Running PLUR v${versionCheck.current} — latest is v${versionCheck.latest} (${behind} minor versions behind). Known bugs may be present. Update immediately: npx @plur-ai/mcp@latest`
            guide = `⚠️ ${version_warning}\n\n${guide}`
          } else {
            version_warning = `Update available: PLUR v${versionCheck.current} → v${versionCheck.latest}. Run: npx @plur-ai/mcp@latest`
          }
        }

        // Project scope guidance (#177) — surface auto-detected project
        // scope so the agent knows engrams will be tagged with it.
        if (scope_source === 'project-config') {
          guide += `\n\nAuto-detected project scope: "${default_scope}" (from .plur.yaml in the current project). ` +
            `plur_learn calls without an explicit scope will be tagged with this scope, keeping this project's ` +
            `knowledge separate from your other projects. Pass scope: "global" only for genuinely cross-project ` +
            `knowledge (general coding conventions, language gotchas, tool quirks).`
        } else if (scope_source === 'none') {
          // No project scope detected — warn about cross-project context bleed
          // (this is the #177 failure mode: agents that don't pass scope get
          // 'global', and global pollutes every future session).
          guide += `\n\n⚠️ No project scope detected. plur_learn calls without explicit scope will be tagged ` +
            `"global" and will appear in EVERY project's future sessions. Create a .plur.yaml NOW to prevent this: ` +
            `scope: "project:<your-project-name>". (This is every project's PERSONAL recall context, NOT team ` +
            `shared stores — use an explicit shared scope like project:/group: to reach a team store.) ` +
            `Note: an explicit scope=global RECALL surfaces all your personal engrams, but scope=global INJECT is ` +
            `targeted to the global namespace only — don't be surprised if a local engram a global recall finds is ` +
            `absent from a global inject.`
        }

        // Append remote scope guidance to guide text (#229)
        if (remote_scopes.length > 0) {
          // #426: scope names/descriptions render into the guide — the agent's
          // directive surface. Strip control chars + bound length so a server- or
          // config-supplied value can't inject instructions. (`me()` already
          // validates /me scope grammar; this also covers config-sourced metadata.)
          const safe = (x: unknown) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
          // #345/#346: when a scope declares self-describing metadata, show what
          // it's FOR (description + covers) inline so the agent can route by
          // purpose, not just by name. Falls back to the bare "scope" name.
          const scopeList = remote_scopes.map(s => {
            const detail = [
              s.description ? `— ${safe(s.description)}` : '',
              s.covers && s.covers.length > 0 ? `(covers: ${s.covers.map(safe).join(', ')})` : '',
            ].filter(Boolean).join(' ')
            return detail ? `"${safe(s.scope)}" ${detail}` : `"${safe(s.scope)}"`
          }).join('; ')
          guide += default_scope
            ? `\n\nSession default scope is set to "${default_scope}". To route an engram to a remote ` +
              `enterprise store instead, pass scope explicitly to plur_learn (available remote scopes: ${scopeList}).`
            : `\n\nRemote store scopes available: ${scopeList}. Set scope PER ENGRAM by content: when an engram is ` +
              `relevant to the team (engineering patterns, architecture decisions, project conventions), set scope to ` +
              `the matching remote scope in plur_learn. Personal preferences, local project details, and corrections ` +
              `specific to your workflow can be left unscoped (they land at the unscoped default, "global" — the ` +
              `cross-project personal namespace). Do NOT let TEAM knowledge fall back to "global" — without an ` +
              `explicit scope it will, and it will never reach the shared store.`

          // Surface authorized-but-unregistered scopes (#292). Best-effort:
          // gated to enterprise users (remote stores configured), bounded by a
          // short timeout, and fully swallowed on error — never blocks or fails
          // session_start. Only hints when there's actually something to add.
          try {
            const discoveries = await plur.discoverRemoteScopes({ timeoutMs: 3000 })
            // #295: surface auth/reachability failures LOUDLY. discoverRemoteScopes
            // already probed /me per URL — a failure here means team-scoped writes
            // are silently queuing to the outbox. Don't swallow it.
            const failures = discoveries.filter(d => !d.ok)
            if (failures.length > 0) {
              const authExpired = failures.some(f => /\b40[13]\b/.test(f.error ?? ''))
              const pending = outbox_result?.failed ?? 0
              const urls = [...new Set(failures.map(f => f.url))].join(', ')
              guide += authExpired
                ? `\n\n⚠️ ENTERPRISE STORE AUTH FAILED (token expired/invalid): ${urls}. ` +
                  `Team-scoped engrams are NOT syncing` + (pending > 0 ? ` — ${pending} queued in the outbox` : '') +
                  `. Reauth: open <host>/auth/github (or <host>/me/api-keys) in a browser, paste the token into ` +
                  `~/.plur/config.yaml, then restart Claude/MCP. Queued engrams flush on the next session_start.`
                : `\n\n⚠️ ENTERPRISE STORE UNREACHABLE: ${urls}. ` +
                  `Reads fall back to local; team-scoped writes queue in the outbox` +
                  (pending > 0 ? ` (${pending} pending)` : '') + ` until it recovers. Check connectivity/VPN.`
            }
            const unregistered = [...new Set(discoveries.filter(d => d.ok).flatMap(d => d.unregistered))]
            if (unregistered.length > 0) {
              const list = unregistered.map(s => `"${safe(s)}"`).join(', ')
              guide += `\n\n🔎 Your token is authorized for ${unregistered.length} more scope(s) not yet registered: ${list}. ` +
                `Call plur_scopes_discover with register:true to add them all in one step.`
            }
          } catch { /* discovery is best-effort — never block session_start */ }

          // #295: proactive token-expiry warning — purely local JWT decode, no
          // network round-trip. Catches the 30-day silent-expiry before it bites.
          try {
            for (const t of plur.remoteTokenExpiries()) {
              if (t.expired) {
                guide += `\n\n⚠️ Enterprise token for ${t.url} EXPIRED ${t.expiresAt ?? ''}. Reauth and restart to resume team sync.`
              } else if (typeof t.expiresInDays === 'number' && t.expiresInDays <= 7) {
                guide += `\n\n⏳ Enterprise token for ${t.url} expires in ${t.expiresInDays}d. Mint a fresh one (<host>/me/api-keys) before it lapses.`
              }
            }
          } catch { /* best-effort */ }
        }

        return {
          session_id,
          engrams: engrams ?? [],
          store_stats,
          guide,
          // Remote scope routing info (#229)
          ...(remote_scopes.length > 0 ? { remote_scopes } : {}),
          ...(default_scope ? { default_scope, scope_source } : {}),
          // Ask LLM to check back — MCP can't push, but we can request a follow-up
          follow_up: store_stats.engram_count === 0
            ? 'This is a fresh store with 0 engrams. After your first exchange with the user, review what you learned and call plur_learn for any corrections, preferences, or patterns. Build the memory from this session.'
            : undefined,
          // On fresh install, suggest hook setup for reliable injection
          setup_hint: isFreshInstall
            ? 'IMPORTANT: For reliable memory injection, ask the user to run: npx @plur-ai/cli init — this installs Claude Code hooks that automatically inject engrams at conversation start and after context compaction. Without hooks, memory injection depends on you remembering to call plur_session_start.'
            : undefined,
          // Outbox flush results (issue #26)
          ...(outbox_result && (outbox_result.flushed > 0 || outbox_result.failed > 0) ? {
            outbox: {
              flushed: outbox_result.flushed,
              pending: outbox_result.failed,
              warnings: outbox_result.expired_warnings,
            },
          } : {}),
          // Version staleness warning (issue #151)
          ...(version_warning ? { version_warning, version: VERSION } : {}),
        }
      },
    },

    {
      name: 'plur_session_end',
      description: `End a session. BEFORE calling this tool, review the conversation and extract learnings:

1. Corrections the user made ("no, use X not Y") → type: behavioral
2. Preferences stated ("always X", "never Y") → type: behavioral
3. Codebase patterns discovered (naming, structure, conventions) → type: architectural
4. Technical facts learned (API quirks, config, gotchas) → type: procedural
5. Terminology defined or clarified → type: terminological

Include at least one engram_suggestion if ANYTHING was learned. An empty suggestions array means nothing worth remembering happened — this should be rare.`,
      annotations: { title: 'Session End', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What happened in this session (1-3 sentences)' },
          session_id: { type: 'string', description: 'Session ID from plur_session_start' },
          engram_suggestions: {
            type: 'array',
            items: {
              // Prefer {statement, type} objects. Bare strings are tolerated
              // and treated as {statement: <string>} (issue #231).
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    statement: { type: 'string', description: 'A concise, reusable assertion. Write it as advice to your future self.' },
                    type: { type: 'string', enum: ['behavioral', 'terminological', 'procedural', 'architectural'] },
                  },
                  required: ['statement'],
                },
              ],
            },
            description: 'Learnings from this session. Preferred shape is {statement: "...", type?: "..."}; bare strings are also accepted and treated as the statement. Review the conversation for corrections, preferences, patterns, and technical facts before calling.',
          },
        },
        required: ['summary', 'engram_suggestions'],
      },
      handler: async (args, plur) => {
        const summary = args.summary as string
        const session_id = args.session_id as string | undefined
        const suggestions = args.engram_suggestions as unknown[] | undefined

        // Create engrams from suggestions. Tolerate bare strings (a common
        // LLM mistake — see issue #231) by coercing them into {statement} objects.
        let engrams_created = 0
        if (Array.isArray(suggestions) && suggestions.length) {
          for (let i = 0; i < suggestions.length; i++) {
            const s = suggestions[i]
            let statement: string | undefined
            let type: string | undefined
            if (typeof s === 'string') {
              statement = s
            } else if (s && typeof s === 'object') {
              statement = (s as any).statement
              type = (s as any).type
            }
            if (typeof statement !== 'string' || statement.length === 0) {
              throw new Error(
                `engram_suggestions[${i}] must be a string or {statement: string, type?: string}, got ${typeof s}`,
              )
            }
            plur.learn(statement, { type: type as any })
            engrams_created++
          }
        }

        // Capture episode
        const episode = plur.capture(summary, {
          session_id,
          channel: 'mcp',
        })

        // Clean up session checkpoint (#215) — session ended cleanly
        try {
          const plurDir = process.env.PLUR_PATH ?? join(homedir(), '.plur')
          const sessionsDir = join(plurDir, 'sessions')
          // Try session_id first, then CLAUDE_SESSION_ID, then ppid
          const keys = [session_id, process.env.CLAUDE_SESSION_ID, String(process.ppid)]
            .filter(Boolean)
            .map(k => k!.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64))
          for (const key of keys) {
            const cp = join(sessionsDir, `${key}.checkpoint.json`)
            if (existsSync(cp)) { unlinkSync(cp); break }
          }
        } catch { /* cleanup is best-effort */ }

        const status = plur.status()

        return {
          engrams_created,
          episode_id: episode.id,
          total_engrams: status.engram_count,
          hint: engrams_created === 0
            ? 'No engrams captured this session. If any corrections, preferences, or patterns came up, consider calling plur_learn before ending.'
            : undefined,
        }
      },
    },

    {
      name: 'plur_stores_add',
      description: 'Register an additional engram store. Either filesystem (path) or remote (url+token, e.g. PLUR Enterprise). One remote URL can host multiple scopes — call once per team scope you are authorized for; each registers independently. Returns status: "added" or "already_registered".',
      annotations: { title: 'Add store', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Filesystem path to engrams.yaml (omit if registering a remote store)' },
          url:     { type: 'string', description: 'Remote store base URL, e.g. https://plur.datafund.io/sse — pair with token' },
          token:   { type: 'string', description: 'Bearer token (JWT or plur_sk_... API key) for remote stores' },
          scope:   { type: 'string', description: 'Scope identifier (e.g. space:1-datafund, group:plur/plur-ai/engineering)' },
          shared:  { type: 'boolean', description: 'Whether this store is git-committed / team-visible (remote stores default true)' },
          readonly:{ type: 'boolean', description: 'Whether this store is read-only (e.g. purchased packs)' },
        },
        required: ['scope'],
      },
      handler: async (args, plur) => {
        const path  = args.path  as string | undefined
        const url   = args.url   as string | undefined
        const token = args.token as string | undefined
        if (!path && !url) return { error: 'Either path or url must be provided' }
        if (path && url) return { error: 'Provide path OR url, not both' }
        // status distinguishes a real registration from an idempotent no-op so
        // the caller is never told a scope was added when it already existed
        // (#291). A second scope on an already-registered remote URL now
        // genuinely persists, so success:true here is honest.
        const requestedScope = args.scope as string
        const result = plur.addStore(path ?? '', requestedScope, {
          shared:   args.shared   as boolean | undefined,
          readonly: args.readonly as boolean | undefined,
          url, token,
        })
        // #406: a local store is identified by its PATH, so registering a NEW
        // scope on an already-registered path is a no-op for that scope — the
        // existing entry's scope wins and the requested scope is dropped. Reporting
        // success:true there is misleading; surface the drop honestly.
        const scopeDropped = result.status === 'already_registered' && result.scope !== requestedScope
        return {
          success: !scopeDropped,
          status: result.status,
          ...(path ? { path } : { url }),
          // On already_registered this is the EXISTING entry's scope — for
          // local stores (path-only identity) it may differ from the request.
          scope: result.scope,
          ...(scopeDropped ? {
            requested_scope: requestedScope,
            note: `This path is already registered under scope "${result.scope}". A local store is keyed by its path, so the requested scope "${requestedScope}" was NOT added. Use a separate store file for a different scope, or remove the existing entry first.`,
          } : {}),
          kind: url ? 'remote' : 'filesystem',
        }
      },
    },

    {
      name: 'plur_stores_list',
      description: 'List all configured engram stores with their scope, path, and engram count. When a store declares self-describing scope metadata, its description and covers (topics the scope is the home for) are included so you can pick the right scope.',
      annotations: { title: 'List stores', readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, plur) => {
        // Use async variant so remote store engram_count reflects real data
        // even on first call after server start (issue #184).
        const stores = await plur.listStoresAsync()
        const outboxCount = plur.outboxCount()
        return {
          stores,
          count: stores.length,
          ...(outboxCount > 0 ? { outbox_pending: outboxCount } : {}),
        }
      },
    },

    {
      name: 'plur_suggest_scope',
      description: 'Suggest which registered scope(s) an engram belongs in, ranked by fit. Deterministic — no LLM, no network. Scores the statement keywords, optional domain (a dotted namespace like "plur.core.security"), and tags against the covers[] each scope declares. ADVISORY ONLY: this does not route or store anything; pass the chosen scope to plur_learn yourself. Returns candidates sorted by confidence (empty when nothing matches).',
      annotations: { title: 'Suggest scope', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The engram statement to route' },
          domain:    { type: 'string', description: 'Optional dotted namespace for the engram (e.g. "plur.core.security") — strongest routing signal' },
          tags:      { type: 'array', items: { type: 'string' }, description: 'Optional tags on the engram' },
        },
        required: ['statement'],
      },
      handler: async (args, plur) => {
        const candidates = plur.suggestScope({
          statement: args.statement as string,
          domain: args.domain as string | undefined,
          tags: args.tags as string[] | undefined,
        })
        return { candidates, count: candidates.length }
      },
    },

    {
      name: 'plur_scopes_discover',
      description: 'Discover which scopes your remote token is authorized for via the enterprise server (GET /api/v1/me), and which of those are not yet registered locally. Read-only by default; pass register:true to register all authorized-but-unregistered scopes in one step. Only shared-family scopes (group:/project:/space:/team:/org:/public) are auto-registered — personal-family scopes (global/local/user:*/agent:*) advertised by /me are skipped and surfaced in the result. Use this when you have access to multiple team scopes on one server.',
      annotations: { title: 'Discover scopes', readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          url:      { type: 'string', description: 'Limit discovery to this remote URL (default: all configured remote stores)' },
          register: { type: 'boolean', description: 'Register all authorized-but-unregistered scopes (default false — discovery is read-only)' },
        },
      },
      handler: async (args, plur) => {
        const url = args.url as string | undefined
        const register = args.register === true
        const discoveries = await plur.discoverRemoteScopes({ url })
        if (discoveries.length === 0) {
          return { discovered: [], note: 'No remote stores configured. Register one scope first with plur_stores_add, then discover the rest.' }
        }
        if (!register) {
          return { discovered: discoveries }
        }
        const registered = await plur.registerDiscoveredScopes({ url })
        return { discovered: discoveries, registered }
      },
    },

    {
      name: 'plur_promote',
      description: 'Activate candidate engrams so they appear in injection results',
      annotations: { title: 'Promote', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Single engram ID to promote' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Multiple engram IDs to promote' },
        },
      },
      handler: async (args, plur) => {
        const targetIds = (args.ids as string[] | undefined) ?? (args.id ? [args.id as string] : [])
        if (targetIds.length === 0) throw new Error('Provide id or ids')

        const promoted: Array<{ id: string; statement: string }> = []
        const errors: Array<{ id: string; error: string }> = []

        for (const id of targetIds) {
          const engram = plur.getById(id)
          if (!engram) { errors.push({ id, error: 'Not found' }); continue }
          if (engram.status === 'active') { errors.push({ id, error: 'Already active' }); continue }
          if (engram.status === 'retired') { errors.push({ id, error: 'Cannot promote retired' }); continue }

          engram.status = 'active'
          engram.activation.retrieval_strength = 0.7
          engram.activation.storage_strength = 1.0
          engram.activation.last_accessed = new Date().toISOString().split('T')[0]
          plur.updateEngram(engram)
          promoted.push({ id, statement: engram.statement })
        }

        return { promoted, errors, success: errors.length === 0 }
      },
    },

    {
      name: 'plur_tensions',
      description: 'List or scan for engram pairs that have conflicting knowledge. Without scan mode, shows previously detected conflicts. With scan:true, runs an active LLM-powered contradiction scan and returns only high-confidence tensions.',
      annotations: { title: 'Tensions', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Filter by scope' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          scan: { type: 'boolean', description: 'Run an active contradiction scan using an LLM judge. Requires OPENAI_API_KEY or OPENROUTER_API_KEY env var, or explicit llm_base_url + llm_api_key args.' },
          llm_base_url: { type: 'string', description: 'OpenAI-compatible API base URL for scan mode (e.g. https://api.openai.com/v1)' },
          llm_api_key: { type: 'string', description: 'API key for the LLM (scan mode)' },
          llm_model: { type: 'string', description: 'Model name for scan mode (default: gpt-4o-mini)' },
          min_confidence: { type: 'number', description: 'Minimum confidence threshold for scan mode (0–1, default: 0.7)' },
          max_pairs: { type: 'number', description: 'Maximum candidate pairs to evaluate in scan mode (default: 50)' },
        },
      },
      handler: async (args, plur) => {
        const engrams = plur.list({
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
        })

        if (args.scan) {
          const llm = args.llm_base_url && args.llm_api_key
            ? makeHttpLlm(args.llm_base_url as string, args.llm_api_key as string, args.llm_model as string | undefined)
            : getLlmFunction()

          if (!llm) {
            return {
              error: 'scan mode requires an LLM. Set OPENAI_API_KEY or OPENROUTER_API_KEY, or pass llm_base_url + llm_api_key.',
              tensions: [],
              count: 0,
            }
          }

          const result = await scanForTensions(engrams, llm, {
            min_confidence: args.min_confidence as number | undefined,
            max_pairs: args.max_pairs as number | undefined,
          })

          return {
            pairs_checked: result.pairs_checked,
            count: result.new_tensions,
            tensions: result.tensions.map(t => ({
              engram_a: { id: t.id_a, statement: t.statement_a },
              engram_b: { id: t.id_b, statement: t.statement_b },
              confidence: t.confidence,
              reason: t.reason,
            })),
          }
        }

        // Legacy mode: read from relations.conflicts (kept for backward compat;
        // returns empty for stores that have been through purgeTensions).
        const tensions: Array<{
          engram_a: { id: string; statement: string; type: string }
          engram_b: { id: string; statement: string; type: string }
          detected_at: string
          purge_hint?: string
        }> = []

        const seen = new Set<string>()

        for (const engram of engrams) {
          if (!engram.relations?.conflicts?.length) continue
          for (const conflictId of engram.relations.conflicts) {
            const pairKey = [engram.id, conflictId].sort().join(':')
            if (seen.has(pairKey)) continue
            seen.add(pairKey)

            const other = engrams.find(e => e.id === conflictId)
            if (!other) continue

            tensions.push({
              engram_a: { id: engram.id, statement: engram.statement, type: engram.type },
              engram_b: { id: other.id, statement: other.statement, type: other.type },
              detected_at: engram.activation.last_accessed,
              purge_hint: 'These conflicts are from the legacy detection system. Run plur_tensions_purge to clear them, then use scan:true for active contradiction detection.',
            })
          }
        }

        const purge_hint = tensions.length > 0
          ? 'These are legacy conflict relations. Run plur_tensions_purge to clear them.'
          : undefined

        return { tensions, count: tensions.length, ...(purge_hint ? { purge_hint } : {}) }
      },
    },

    {
      name: 'plur_tensions_purge',
      description: 'Purge all conflict relations from local engrams — removes accumulated false positives from the legacy tension-detection system',
      annotations: { title: 'Purge Tensions', destructiveHint: true, idempotentHint: true },
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, plur) => {
        const result = plur.purgeTensions()
        return {
          purged_conflict_refs: result.purged_count,
          engrams_modified: result.engrams_modified,
          message: `Purged ${result.purged_count} conflict references from ${result.engrams_modified} engrams.`,
        }
      },
    },

    {
      name: 'plur_episode_to_engram',
      description: 'Promote an episode to a persistent episodic engram — useful when a session event deserves long-term memory',
      annotations: { title: 'Episode to Engram', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          episode_id: { type: 'string', description: 'Episode ID to promote (from plur_timeline)' },
          scope: { type: 'string', description: 'Scope for the new engram' },
          domain: { type: 'string', description: 'Domain tag for the new engram' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the new engram' },
        },
        required: ['episode_id'],
      },
      handler: async (args, plur) => {
        const engram = plur.episodeToEngram(args.episode_id as string, {
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          tags: args.tags as string[] | undefined,
        })
        return {
          id: engram.id,
          statement: engram.statement,
          memory_class: (engram as any).knowledge_type?.memory_class,
          episode_ids: (engram as any).episode_ids,
          source: engram.source,
        }
      },
    },

    {
      name: 'plur_history',
      description: 'View the event-sourced history of an engram or all recent history — shows creation, updates, feedback, and evolution events',
      annotations: { title: 'History', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          engram_id: { type: 'string', description: 'Filter history for a specific engram ID. If omitted, returns recent history across all engrams.' },
          limit: { type: 'number', description: 'Max events to return (default 50)' },
        },
      },
      handler: async (args, plur) => {
        const engramId = args.engram_id as string | undefined
        const limit = (args.limit as number | undefined) ?? 50

        if (engramId) {
          const events = plur.getEngramHistory(engramId)
          return {
            engram_id: engramId,
            events: events.slice(-limit),
            total: events.length,
          }
        }

        // Return recent history across all engrams
        const { listHistoryMonths, readHistory } = await import('@plur-ai/core')
        const status = plur.status()
        const months = listHistoryMonths(status.storage_root)
        const allEvents: Array<Record<string, unknown>> = []
        // Read from most recent months first
        for (const month of months.reverse()) {
          const events = readHistory(status.storage_root, month)
          allEvents.push(...events)
          if (allEvents.length >= limit) break
        }
        // Return most recent events
        return {
          events: allEvents.slice(-limit),
          total: allEvents.length,
        }
      },
    },

    {
      name: 'plur_report_failure',
      description: 'Report a failure for a procedural engram — triggers procedure evolution via LLM if configured. Only works on procedural engrams. Max 3 revisions per procedure per 24h.',
      annotations: { title: 'Report Failure', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          engram_id: { type: 'string', description: 'ID of the procedural engram that failed' },
          failure_context: { type: 'string', description: 'Description of what went wrong when following this procedure' },
          llm_base_url: { type: 'string', description: 'OpenAI-compatible API base URL for procedure evolution' },
          llm_api_key: { type: 'string', description: 'API key for the LLM' },
          llm_model: { type: 'string', description: 'Model name (default: gpt-4o-mini)' },
        },
        required: ['engram_id', 'failure_context'],
      },
      handler: async (args, plur) => {
        let llm: LlmFunction | undefined
        if (args.llm_base_url && args.llm_api_key) {
          llm = makeHttpLlm(
            args.llm_base_url as string,
            args.llm_api_key as string,
            args.llm_model as string | undefined,
          )
        }

        const result = await plur.reportFailure(
          args.engram_id as string,
          args.failure_context as string,
          llm,
        )

        return {
          engram_id: result.engram.id,
          statement: result.engram.statement,
          evolved: result.evolved,
          engram_version: (result.engram as any).engram_version ?? 1,
          failure_episode_id: result.episode.id,
          note: result.evolved
            ? 'Procedure was improved based on the failure report'
            : 'Failure logged but procedure was not rewritten (no LLM configured or LLM unavailable)',
        }
      },
    },

    {
      name: 'plur_packs_export',
      description: 'Export engrams as a shareable thematic pack with privacy scanning and integrity hash. Filters out private and secret-containing engrams automatically. Output goes to ~/plur-packs/<name> by default.',
      annotations: { title: 'Export pack', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Pack name (e.g. "react-patterns", "mcp-design")' },
          description: { type: 'string', description: 'Pack description' },
          filter_domain: { type: 'string', description: 'Filter engrams by domain prefix (e.g. "mcp", "trading")' },
          filter_scope: { type: 'string', description: 'Filter engrams by scope (e.g. "global", "project:myapp")' },
          filter_tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
          filter_type: { type: 'string', enum: ['behavioral', 'procedural', 'architectural', 'terminological'], description: 'Filter by engram type' },
          output_dir: { type: 'string', description: 'Output directory (default: ~/plur-packs/<name>)' },
          creator: { type: 'string', description: 'Creator name' },
        },
        required: ['name'],
      },
      handler: async (args, plur) => {
        const name = args.name as string
        let engrams = plur.list({
          domain: args.filter_domain as string | undefined,
          scope: args.filter_scope as string | undefined,
        })

        // Additional thematic filters
        const filterTags = args.filter_tags as string[] | undefined
        if (filterTags) {
          engrams = engrams.filter(e =>
            e.tags && filterTags.some((t: string) => e.tags.includes(t))
          )
        }
        const filterType = args.filter_type as string | undefined
        if (filterType) {
          engrams = engrams.filter(e => e.type === filterType)
        }

        const { homedir } = await import('os')
        const { join } = await import('path')
        const outputDir = (args.output_dir as string) || join(homedir(), 'plur-packs', name)
        const result = plur.exportPack(engrams, outputDir, {
          name,
          version: '1.0.0',
          description: args.description as string | undefined,
          creator: (args.creator as string) || undefined,
        })
        return {
          path: result.path,
          engram_count: result.engram_count,
          integrity: result.integrity,
          match_terms: result.match_terms,
          privacy_clean: result.privacy.clean,
          privacy_issues: result.privacy.issues.length,
          name,
        }
      },
    },

    {
      name: 'plur_similarity_search',
      description: 'Search engrams by cosine similarity, returning scores. Used for dedup classification — scores > 0.9 indicate duplicates, 0.7-0.9 related, < 0.7 new.',
      annotations: { title: 'Similarity search', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find similar engrams' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          scope: { type: 'string', description: 'Filter by scope (also includes global)' },
        },
        required: ['query'],
      },
      handler: async (args, plur) => {
        const results = await plur.similaritySearch(args.query as string, {
          limit: args.limit as number | undefined,
          scope: args.scope as string | undefined,
        })
        return {
          results: results.map(r => ({
            engram_id: r.engram.id,
            statement: r.engram.statement,
            scope: r.engram.scope,
            cosine_score: Math.round(r.score * 1000) / 1000,
            type: r.engram.type,
            polarity: (r.engram as any).polarity,
            tags: r.engram.tags,
          })),
          count: results.length,
        }
      },
    },

    {
      name: 'plur_batch_decay',
      description: 'Apply ACT-R decay to all local engrams. Run weekly. Only decays engrams in the local YAML store — remote-store engrams are not decayed client-side. Returns status transitions only.',
      annotations: { title: 'Batch decay', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          context_scope: { type: 'string', description: 'Scope to skip during decay (engrams in active scope are not decayed)' },
        },
      },
      handler: async (args, plur) => {
        const result = plur.batchDecay({
          contextScope: args.context_scope as string | undefined,
        })
        return result
      },
    },

    {
      name: 'plur_profile',
      description: 'Generate or retrieve a cognitive profile — a narrative summary synthesized from stored engrams. Cached for 24h.',
      annotations: { title: 'Cognitive profile', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Filter engrams by scope' },
          llm_base_url: { type: 'string', description: 'OpenAI-compatible API base URL' },
          llm_api_key: { type: 'string', description: 'API key for the LLM' },
          llm_model: { type: 'string', description: 'Model name' },
          force_regenerate: { type: 'boolean', description: 'Force regeneration (default false)' },
        },
      },
      handler: async (args, plur) => {
        const status = plur.status()
        const storagePath = status.storage_root
        if (!args.force_regenerate) {
          const cached = getProfileForInjection(storagePath)
          if (cached) return { profile: cached, source: 'cache' }
        }
        if (!args.llm_base_url || !args.llm_api_key) {
          const cached = getProfileForInjection(storagePath)
          if (cached) return { profile: cached, source: 'stale_cache' }
          return { profile: null, error: 'No cached profile. Provide llm_base_url and llm_api_key.' }
        }
        const model = (args.llm_model as string) ?? selectModelForOperation('profile', status.config?.llm)
        const llm = makeHttpLlm(args.llm_base_url as string, args.llm_api_key as string, model)
        const engrams = plur.list({ scope: args.scope as string | undefined })
        const profile = await generateProfile(engrams, llm, storagePath, status.config?.profile?.cache_ttl_hours ?? 24)
        return { profile, source: 'generated', engram_count: engrams.length, model }
      },
    },
  ]
}
