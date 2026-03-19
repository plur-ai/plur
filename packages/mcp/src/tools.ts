import { Plur } from '@plur-ai/core'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, plur: Plur) => Promise<unknown>
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'plur.learn',
      description: 'Create an engram — record a reusable learning, preference, or correction',
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
        },
        required: ['statement'],
      },
      handler: async (args, plur) => {
        const engram = plur.learn(args.statement as string, {
          type: args.type as any,
          scope: args.scope as string | undefined,
          domain: args.domain as string | undefined,
          source: args.source as string | undefined,
        })
        return { id: engram.id, statement: engram.statement, scope: engram.scope, type: engram.type }
      },
    },

    {
      name: 'plur.recall',
      description: 'Query engrams by semantic similarity — retrieve relevant learned knowledge',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant engrams' },
          scope: { type: 'string', description: 'Filter by scope (also includes global)' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          min_strength: { type: 'number', description: 'Minimum retrieval strength (0-1)' },
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
      name: 'plur.inject',
      description: 'Get a scored context injection for a task — returns directives and considerations within token budget',
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
        }
      },
    },

    {
      name: 'plur.feedback',
      description: 'Rate an engram\'s usefulness — trains injection relevance over time',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Engram ID (e.g. ENG-001)' },
          signal: {
            type: 'string',
            enum: ['positive', 'negative', 'neutral'],
            description: 'Feedback signal to apply',
          },
        },
        required: ['id', 'signal'],
      },
      handler: async (args, plur) => {
        plur.feedback(args.id as string, args.signal as 'positive' | 'negative' | 'neutral')
        return { success: true, id: args.id, signal: args.signal }
      },
    },

    {
      name: 'plur.forget',
      description: 'Retire an engram — marks it as no longer active without deleting history',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Engram ID to retire' },
          reason: { type: 'string', description: 'Optional reason for retiring this engram' },
        },
        required: ['id'],
      },
      handler: async (args, plur) => {
        plur.forget(args.id as string, args.reason as string | undefined)
        return { success: true, id: args.id, status: 'retired' }
      },
    },

    {
      name: 'plur.capture',
      description: 'Append an episode to the episodic timeline — records what happened in a session',
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
      name: 'plur.timeline',
      description: 'Query the episodic timeline — retrieve past episodes filtered by time, agent, or search',
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
      name: 'plur.ingest',
      description: 'Extract engram candidates from content using pattern matching — optionally auto-save them',
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
      name: 'plur.packs.install',
      description: 'Install an engram pack from a directory path — adds curated engrams to the store',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Path to the pack directory to install' },
        },
        required: ['source'],
      },
      handler: async (args, plur) => {
        const result = plur.installPack(args.source as string)
        return { installed: result.installed, name: result.name, success: true }
      },
    },

    {
      name: 'plur.packs.list',
      description: 'List all installed engram packs',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_args, plur) => {
        const packs = plur.listPacks()
        return {
          packs: packs.map(p => ({
            name: p.name,
            version: p.version,
            description: p.description,
            engram_count: p.engram_count,
          })),
          count: packs.length,
        }
      },
    },

    {
      name: 'plur.status',
      description: 'Return system health — engram count, episode count, pack count, storage root',
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
  ]
}
