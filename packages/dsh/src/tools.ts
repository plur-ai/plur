/**
 * The five model-facing tools.
 *
 * dsh bills every registered tool's schema on every request, so this set is
 * deliberately small — the competitor registers thirteen, and `@plur-ai/mcp`
 * exposes ~40 for users who want the full surface. These five are the ones that
 * earn their place next to injection: a targeted lookup beyond what was already
 * shown, and the write paths a model genuinely needs.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { Counters } from './counters.js'
import { guard, type WriteQueue } from './guard.js'
import type { PlurClient } from './client.js'

/** Dependencies shared by every tool. */
export interface ToolDeps {
  config: Config
  counters: Counters
  plur?: PlurClient
  /** The ONE shared write queue, so tool writes cannot interleave with auto-learn. */
  queue: WriteQueue
  /**
   * Resolves the scope for the CALLING session.
   *
   * Takes the agent because dsh's default profile is a multi-session server:
   * resolving a shared or default scope here would read one project's memories
   * into another project's session, or write them there.
   */
  resolveScope: (agent?: CallerAgent) => Promise<string>
}

/** The slice of the calling agent scope resolution needs. */
export interface CallerAgent {
  readonly id?: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

/** Canonical tool value: one text payload, kept lossless-JSON. */
interface TextValue extends Record<string, unknown> {
  text: string
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object' as const,
    properties: { text: { type: 'string' as const } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: String((value as TextValue | null)?.text ?? '') },
  ],
}

const UNAVAILABLE = 'PLUR is unavailable right now; continuing without memory.'

/**
 * Register the model-facing surface.
 *
 * @param ctx - the Cordis context whose scope owns these registrations.
 * @param deps - config, counters, the PLUR client, and scope resolution.
 * @returns one disposer per registered tool, in registration order.
 */
export function registerTools(ctx: Context, deps: ToolDeps): Array<() => void> {
  const { config, counters, plur, resolveScope, queue } = deps

  /** Read the calling agent off the registry-supplied execution context. */
  const callerOf = (exec: unknown): CallerAgent | undefined =>
    (exec as { agent?: CallerAgent } | null | undefined)?.agent

  /** Run a tool body under the never-throw guard and shape the canonical value. */
  const body = async (fn: () => Promise<string>): Promise<TextValue> => {
    const out = await guard(fn, {
      timeoutMs: config.timeoutMs,
      onError: () => counters.bump('errors_swallowed'),
    })
    return { text: out ?? UNAVAILABLE }
  }

  const definitions = [
    {
      name: 'plur_recall',
      description:
        'Search stored memory for engrams relevant to a query. The most relevant memories are already in your system prompt; use this for a targeted lookup beyond them.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search memory for.' } },
        required: ['query'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      execute: (args: unknown, exec: unknown) => body(async () => {
        const query = String((args as { query?: unknown } | null)?.query ?? '')
        const scope = await resolveScope(callerOf(exec))
        const results = (await plur?.recall?.(query, { scope, limit: 10 })) ?? []
        if (results.length === 0) return 'No matching engrams.'
        return results.map(r => `[${r.id}] ${r.statement}`).join('\n')
      }),
    },
    {
      name: 'plur_learn',
      description:
        'Store a correction, preference, or durable fact so it is remembered in later sessions. Use when the user corrects you or states how they want things done.',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The assertion to remember.' },
          domain: { type: 'string', description: 'Optional dotted domain, e.g. software.deployment.' },
        },
        required: ['statement'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      execute: (args: unknown, exec: unknown) => body(async () => {
        const input = args as { statement?: unknown; domain?: unknown } | null
        const statement = String(input?.statement ?? '').trim()
        if (!statement) return 'Nothing to store: statement was empty.'
        const scope = await resolveScope(callerOf(exec))
        await queue(async () => plur?.learn?.(statement, {
          scope,
          domain: input?.domain === undefined ? undefined : String(input.domain),
        }))
        counters.bump('learn_captured')
        return 'Stored.'
      }),
    },
    {
      name: 'plur_forget',
      description:
        'Retire an engram that is wrong or out of date, by its ID. Memory you can correct is the point; do not leave a known-wrong memory in place.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The engram ID, e.g. ENG-2026-08-14-017.' },
          reason: { type: 'string', description: 'Why it is being retired.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      execute: (args: unknown, exec: unknown) => body(async () => {
        const input = args as { id?: unknown; reason?: unknown } | null
        const id = String(input?.id ?? '').trim()
        if (!id) return 'Nothing to retire: id was empty.'
        const scope = await resolveScope(callerOf(exec))
        await queue(async () => plur?.forget?.(id, input?.reason === undefined ? undefined : String(input.reason), { scope }))
        return 'Retired.'
      }),
    },
    {
      name: 'plur_feedback',
      description:
        'Rate whether a memory shown to you was useful. This trains what surfaces next time, so rate honestly when an injected memory helped or misled.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The engram ID being rated.' },
          signal: { type: 'string', enum: ['positive', 'negative'] },
        },
        required: ['id', 'signal'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      execute: (args: unknown, exec: unknown) => body(async () => {
        const input = args as { id?: unknown; signal?: unknown } | null
        const id = String(input?.id ?? '').trim()
        if (!id) return 'Nothing to rate: id was empty.'
        const scope = await resolveScope(callerOf(exec))
        await queue(async () => plur?.feedback?.(id, input?.signal === 'negative' ? 'negative' : 'positive', scope))
        return 'Recorded.'
      }),
    },
    {
      name: 'plur_status',
      description:
        'Report memory-system health and this session\'s memory activity counters. Use when asked why something was or was not remembered.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: (_args: unknown, exec: unknown) => body(async () => {
        const scope = await resolveScope(callerOf(exec))
        const snapshot = counters.snapshot()
        return [
          `scope: ${scope}`,
          `injection: ${config.injectionMode}`,
          ...Object.entries(snapshot).map(([key, value]) => `${key}: ${value}`),
        ].join('\n')
      }),
    },
  ]

  // Registration is guarded: a host that rejects a definition — a duplicate name
  // after a hot reload, a schema the registry stops accepting — must not abort
  // plugin mount and take the user's agent down at startup.
  return definitions.map(definition => {
    try {
      return ctx.tools.register(definition as never)
    } catch {
      counters.bump('errors_swallowed')
      return () => {}
    }
  })
}
