import { Plur, extractMetaEngrams, validateMetaEngram, confidenceBand, generateProfile, getProfileForInjection, selectModelForOperation } from '@plur-ai/core'
import type { LlmFunction, MetaField } from '@plur-ai/core'

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
          source: { type: 'string', description: 'Origin of this knowledge' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Searchable keyword tags' },
          rationale: { type: 'string', description: 'Why this knowledge matters' },
          visibility: { type: 'string', enum: ['private', 'public', 'template'], description: 'Visibility level' },
          knowledge_anchors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Path to related document' },
                relevance: { type: 'string', enum: ['primary', 'supporting', 'example'] },
                snippet: { type: 'string', description: 'Short snippet (max 200 chars)' },
              },
              required: ['path'],
            },
            description: 'Links to related knowledge documents',
          },
          dual_coding: {
            type: 'object',
            properties: {
              example: { type: 'string', description: 'Concrete example' },
              analogy: { type: 'string', description: 'Analogy to aid understanding' },
            },
            description: 'Dual coding for richer encoding',
          },
          abstract: { type: 'string', description: 'Abstract engram ID this was derived from' },
          derived_from: { type: 'string', description: 'Source engram ID this was derived from' },
        },
        required: ['statement'],
      },
      handler: async (args, plur) => {
        const engram = plur.learn(args.statement as string, {
          type: args.type as any,
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          source: args.source as string | undefined,
          tags: args.tags as string[] | undefined,
          rationale: args.rationale as string | undefined,
          visibility: args.visibility as any,
          knowledge_anchors: args.knowledge_anchors as any,
          dual_coding: args.dual_coding as any,
          abstract: args.abstract as string | undefined,
          derived_from: args.derived_from as string | undefined,
        })
        return { id: engram.id, statement: engram.statement, scope: engram.scope, type: engram.type }
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
          min_strength: { type: 'number', description: 'Minimum retrieval strength (0-1)' },
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
          min_strength: args.min_strength as number | undefined,
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
          min_strength: { type: 'number', description: 'Minimum retrieval strength (0-1)' },
          budget: { type: 'object', description: 'Budget constraints for sub-agents', properties: { max_tokens: { type: 'number' }, max_results: { type: 'number' } } },
          caller_session_id: { type: 'string', description: 'Caller session ID for budget enforcement' },
        },
        required: ['query'],
      },
      handler: async (args, plur) => {
        const budget = args.budget as { max_tokens?: number; max_results?: number } | undefined
        const effectiveLimit = budget?.max_results ?? (args.limit as number | undefined) ?? 20
        const results = await plur.recallHybrid(args.query as string, {
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          limit: effectiveLimit,
          min_strength: args.min_strength as number | undefined,
        })
        let truncated = false
        let bounded = results
        if (budget?.max_results && results.length > budget.max_results) { bounded = results.slice(0, budget.max_results); truncated = true }
        if (budget?.max_tokens) {
          let tc = 0; const wb = []
          for (const e of bounded) { const t = Math.ceil(e.statement.length/4)+20; if (tc+t>budget.max_tokens){truncated=true;break}; wb.push(e); tc+=t }
          bounded = wb
        }
        return {
          results: bounded.map(e => ({ id: e.id, statement: e.statement, type: e.type, scope: e.scope, domain: e.domain, retrieval_strength: e.activation.retrieval_strength })),
          count: bounded.length, truncated, mode: 'hybrid',
        }
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
              plur.feedback(id, signal)
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
          plur.feedback(args.id as string, args.signal as 'positive' | 'negative' | 'neutral')
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
          plur.forget(args.id as string)
          return { success: true, retired: { id: engram.id, statement: engram.statement } }
        }
        if (args.search) {
          const matches = plur.recall(args.search as string, { limit: 100 })
          if (matches.length === 0) return { success: false, error: `No active engrams matching "${args.search}"` }
          if (matches.length === 1) {
            plur.forget(matches[0].id)
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
      description: 'Return system health — engram count, episode count, pack count, storage root',
      annotations: { title: 'Status', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_args, plur) => {
        const status = plur.status()
        return {
          engram_count: status.engram_count,
          episode_count: status.episode_count,
          pack_count: status.pack_count,
          storage_root: status.storage_root,
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
      description: 'Register an additional engram store at a filesystem path with a scope identifier',
      annotations: { title: 'Add store', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Filesystem path to engrams.yaml' },
          scope: { type: 'string', description: 'Scope identifier (e.g. space:1-datafund, module:trading)' },
          shared: { type: 'boolean', description: 'Whether this store is git-committed / team-visible' },
          readonly: { type: 'boolean', description: 'Whether this store is read-only (e.g. purchased packs)' },
        },
        required: ['path', 'scope'],
      },
      handler: async (args, plur) => {
        plur.addStore(args.path as string, args.scope as string, {
          shared: args.shared as boolean | undefined,
          readonly: args.readonly as boolean | undefined,
        })
        return { success: true, path: args.path, scope: args.scope }
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
      name: 'plur_profile',
      description: 'Generate or retrieve cognitive profile from stored engrams. Cached 24h.',
      annotations: { title: 'Cognitive profile', readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: 'object', properties: {
        scope: { type: 'string' }, llm_base_url: { type: 'string' }, llm_api_key: { type: 'string' },
        llm_model: { type: 'string' }, force_regenerate: { type: 'boolean' },
      }},
      handler: async (args, plur) => {
        const status = plur.status()
        if (!args.force_regenerate) { const c = getProfileForInjection(status.storage_root); if (c) return { profile: c, source: 'cache' } }
        if (!args.llm_base_url || !args.llm_api_key) { const c = getProfileForInjection(status.storage_root); return c ? { profile: c, source: 'stale_cache' } : { profile: null, error: 'No LLM configured' } }
        const model = (args.llm_model as string) ?? selectModelForOperation('profile', status.config?.llm)
        const llm = makeHttpLlm(args.llm_base_url as string, args.llm_api_key as string, model)
        const engrams = plur.list({ scope: args.scope as string | undefined })
        const profile = await generateProfile(engrams, llm, status.storage_root, status.config?.profile?.cache_ttl_hours ?? 24)
        return { profile, source: 'generated', engram_count: engrams.length, model }
      },
    },
  ]
}
