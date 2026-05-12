import { Plur, extractMetaEngrams, validateMetaEngram, confidenceBand, generateProfile, getProfileForInjection, markProfileDirty, selectModelForOperation, readHistoryForEngram } from '@plur-ai/core'
import type { LlmFunction, MetaField } from '@plur-ai/core'
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

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'plur_learn',
      description: 'Create an engram — record a reusable learning, preference, or correction',
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
          llm,
        }
        // Route through learnRouted FIRST so remote-scope writes get
        // the server-assigned engram id (e.g. ENG-2026-05-06-007).
        // Without this, the caller sees a local placeholder id like
        // ENG-2026-0506-017 and any later forget(id)/feedback(id) call
        // against that placeholder fails — the engram only exists on
        // the server with the server's id. For local-scope writes,
        // learnRouted defers to sync learn() so dedup behavior is
        // unchanged. We try learnAsync second only as a fallback for
        // the LLM-driven dedup pathway (local routes).
        try {
          const engram = await plur.learnRouted(args.statement as string, context)
          return {
            id: engram.id, statement: engram.statement,
            scope: engram.scope, type: engram.type,
            pinned: (engram as any).pinned === true,
            decision: 'ADD',
          }
        } catch (err) {
          // learnRouted throws when remote-write fails (network down,
          // 5xx, etc). Fall back to sync learn() so the user gets
          // *something* recorded locally — but warn loudly that the
          // returned id is local-only and will not match the server.
          const engram = plur.learn(args.statement as string, context)
          return {
            id: engram.id, statement: engram.statement,
            scope: engram.scope, type: engram.type, decision: 'ADD',
            warning: `Remote write failed (${(err as Error).message}); fell back to local. The id above is the local placeholder — the canonical engram is NOT on the server.`,
          }
        }
      },
    },

    {
      name: 'plur_recall',
      description: 'Query engrams by BM25 keyword matching — use plur_recall_hybrid for semantic similarity',
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
        const updated = plur.setPinned(args.id as string, target)
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
          if (!engram) throw new Error(`Engram not found: ${args.id}`)
          if (engram.status === 'retired') return { success: false, error: `Already retired: ${args.id}` }
          await plur.forget(args.id as string)
          return { success: true, retired: { id: engram.id, statement: engram.statement } }
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
      description: 'Sync engrams via git — initializes repo on first call, commits and pushes/pulls on subsequent calls. Provide a remote URL on first call to enable cross-device sync.',
      annotations: { title: 'Sync', openWorldHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          remote: {
            type: 'string',
            description: 'Git remote URL (e.g. git@github.com:user/plur-engrams.git). Only needed on first call to set up remote.',
          },
        },
      },
      handler: async (args, plur) => {
        const result = plur.sync(args.remote as string | undefined)
        return result
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
        return {
          version: VERSION,
          engram_count: status.engram_count,
          episode_count: status.episode_count,
          pack_count: status.pack_count,
          storage_root: status.storage_root,
          locked_count: status.locked_count,
          tension_count: status.tension_count,
          versioned_engram_count: status.versioned_engram_count ?? 0,
        }
      },
    },

    {
      name: 'plur_doctor',
      description: 'Diagnose the PLUR install. Reports whether the embedding model loaded, whether hybrid search is fully operational, and what to do if it is degraded. Run this first when recall feels off.',
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
        return {
          ok: checks.every(c => c.ok),
          checks,
          embedder: {
            before_probe: before,
            after_probe: after,
          },
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
        },
        required: ['task'],
      },
      handler: async (args, plur) => {
        const crypto = await import('crypto')
        const session_id = crypto.randomUUID()
        const task = args.task as string
        const tags = args.tags as string[] | undefined

        // Auto-discovery happens in Plur constructor — no manual call needed.

        // Get store stats for context
        const status = plur.status()
        const store_stats = {
          engram_count: status.engram_count,
          episode_count: status.episode_count,
          pack_count: status.pack_count,
        }

        // Inject relevant engrams
        let engrams: { text: string; count: number; injected_ids: string[] } | null = null
        try {
          const result = await plur.injectHybrid(task, {
            scope: tags?.length ? `tags:${tags.join(',')}` : undefined,
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

        return {
          session_id,
          engrams: engrams ?? [],
          store_stats,
          guide,
          // Ask LLM to check back — MCP can't push, but we can request a follow-up
          follow_up: store_stats.engram_count === 0
            ? 'This is a fresh store with 0 engrams. After your first exchange with the user, review what you learned and call plur_learn for any corrections, preferences, or patterns. Build the memory from this session.'
            : undefined,
          // On fresh install, suggest hook setup for reliable injection
          setup_hint: isFreshInstall
            ? 'IMPORTANT: For reliable memory injection, ask the user to run: npx @plur-ai/cli init — this installs Claude Code hooks that automatically inject engrams at conversation start and after context compaction. Without hooks, memory injection depends on you remembering to call plur_session_start.'
            : undefined,
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
              type: 'object',
              properties: {
                statement: { type: 'string', description: 'A concise, reusable assertion. Write it as advice to your future self.' },
                type: { type: 'string', enum: ['behavioral', 'terminological', 'procedural', 'architectural'] },
              },
              required: ['statement'],
            },
            description: 'Learnings from this session. Review the conversation for corrections, preferences, patterns, and technical facts before calling.',
          },
        },
        required: ['summary', 'engram_suggestions'],
      },
      handler: async (args, plur) => {
        const summary = args.summary as string
        const session_id = args.session_id as string | undefined
        const suggestions = args.engram_suggestions as Array<{ statement: string; type?: string }> | undefined

        // Create engrams from suggestions
        let engrams_created = 0
        if (suggestions?.length) {
          for (const s of suggestions) {
            plur.learn(s.statement, { type: s.type as any })
            engrams_created++
          }
        }

        // Capture episode
        const episode = plur.capture(summary, {
          session_id,
          channel: 'mcp',
        })

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
      description: 'Register an additional engram store. Either filesystem (path) or remote (url+token, e.g. PLUR Enterprise).',
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
        plur.addStore(path ?? '', args.scope as string, {
          shared:   args.shared   as boolean | undefined,
          readonly: args.readonly as boolean | undefined,
          url, token,
        })
        return {
          success: true,
          ...(path ? { path } : { url }),
          scope: args.scope,
          kind: url ? 'remote' : 'filesystem',
        }
      },
    },

    {
      name: 'plur_stores_list',
      description: 'List all configured engram stores with their scope, path, and engram count',
      annotations: { title: 'List stores', readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, plur) => {
        const stores = plur.listStores()
        return { stores, count: stores.length }
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
      description: 'List engram pairs that have conflicting knowledge — shows tensions in your memory that may need resolution',
      annotations: { title: 'Tensions', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Filter by scope' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
        },
      },
      handler: async (args, plur) => {
        const engrams = plur.list({
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
        })

        const tensions: Array<{
          engram_a: { id: string; statement: string; type: string }
          engram_b: { id: string; statement: string; type: string }
          detected_at: string
        }> = []

        const seen = new Set<string>()

        for (const engram of engrams) {
          if (!engram.relations?.conflicts?.length) continue
          for (const conflictId of engram.relations.conflicts) {
            // Deduplicate: only show each pair once
            const pairKey = [engram.id, conflictId].sort().join(':')
            if (seen.has(pairKey)) continue
            seen.add(pairKey)

            const other = engrams.find(e => e.id === conflictId)
            if (!other) continue

            tensions.push({
              engram_a: { id: engram.id, statement: engram.statement, type: engram.type },
              engram_b: { id: other.id, statement: other.statement, type: other.type },
              detected_at: engram.activation.last_accessed,
            })
          }
        }

        return { tensions, count: tensions.length }
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
      description: 'Apply ACT-R decay to all engrams. Run weekly. Returns status transitions only.',
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
