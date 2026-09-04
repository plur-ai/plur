import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { Plur, extractMetaEngrams, validateMetaEngram, confidenceBand, generateProfile, getProfileForInjection, markProfileDirty, selectModelForOperation, readHistoryForEngram, getCachedUpdateCheck, minorVersionsBehind, scanForTensions, CapabilityCanary, readProjectConfig, isSharedScope, resolveRerankerName, getReranker, classifyRerankerFailure, hfCacheDirName, SUGGEST_DISPLAY_MIN_CONFIDENCE, mcpRemoteWarningLine, doctorRemoteRemediation, normalizeEndpointUrl, REMOTE_STATUS_TTL_MS, PROBE_CLEARABLE_STATES, emitCheckpoint } from '@plur-ai/core'
import type { LlmFunction, MetaField, TensionStatus, RerankerEvalResult, HistoryEvent, Receipt, RemoteStoreStatusEntry } from '@plur-ai/core'
import { recordTelemetry } from './telemetry.js'
import { VERSION } from './version.js'
import { z } from 'zod'

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
  inputSchema: { type: 'object'; [key: string]: unknown }
  annotations?: ToolAnnotations
  handler: (args: Record<string, unknown>, plur: Plur) => Promise<unknown>
}

/**
 * Render an observation age as a short human suffix (#864).
 *
 * Doctor lines that report a cached outcome must say WHEN it was observed.
 * "Last live recall: timeout" reads as a present-tense fact about the server;
 * "Last live recall: timeout 3h ago" reads as what it is — a record of a past
 * call, which the operator can weigh against the live probe beside it.
 */
function formatAge(ageMs: number | undefined): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return '(age unknown)'
  const s = Math.floor(ageMs / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * A4′ (#776): attach per-host remote degradation to a tool response — ONLY
 * when a host is non-ok or was silently scope-narrowed (`dropped_scopes`).
 * Structured block + ONE prose `warning` line (agent-directed strings from
 * the shared core table — consequence + agent action), mirroring the
 * hybrid-degraded warning pattern above it. Healthy hosts attach nothing.
 */
function attachRemoteStoreDegradation(response: Record<string, unknown>, plur: Plur): void {
  let status: RemoteStoreStatusEntry[]
  try {
    // `freshOnly` (#864): this block speaks in the present tense ("serving
    // local only"), so it may only report observations recent enough to still
    // describe now. The outcome map is written only by hosts a recall dialed,
    // and most tools that reach here dial nothing — without the age bound, one
    // early failure stamps a degradation warning onto every later response for
    // the life of the process, long after the host recovered.
    status = plur.remoteStoreStatus({ freshOnly: true })
  } catch {
    return // surfacing must never break the tool response
  }
  const degraded = status.filter(s => s.status !== 'ok' || (s.dropped_scopes?.length ?? 0) > 0)
  if (degraded.length === 0) return
  response.remote_stores = degraded.map(s => ({
    host: s.host,
    status: s.status,
    ...(s.dropped_scopes && s.dropped_scopes.length > 0 ? { dropped_scopes: s.dropped_scopes } : {}),
  }))
  const line = `Remote store degradation — ${degraded.map(s => mcpRemoteWarningLine(s)).join(' ')}`
  response.warning = typeof response.warning === 'string' && response.warning.length > 0
    ? `${response.warning} ${line}`
    : line
}

/**
 * The canonical `plur_recall` handler (#693).
 *
 * Hoisted out of the tool literal so the deprecated `plur_recall_hybrid`
 * alias can forward to it rather than re-implementing the hybrid branch.
 * Budget capping, episode expansion, the hybrid-degraded warning and the
 * #341 reranker surfacing all live here once — the alias adds only its
 * deprecation notice, so the two cannot drift before the 0.18 removal.
 */
const recallHandler: ToolDefinition['handler'] = async (args, plur) => {
  const mode = (args.mode as string | undefined) ?? 'hybrid'
  if (mode === 'keyword') {
    // `await` added on merge: `recall()` is async as of the Phase 2 write-path
    // flip. Landed on main against the synchronous signature, so without this
    // `results` is a Promise and `.map` below throws.
    const results = await plur.recall(args.query as string, {
      scope: args.scope as string | undefined,
      domain: args.domain as string | undefined,
      limit: args.limit as number | undefined,
      remote_timeout_ms: 2000, // MCP recall remote budget (#776)
      // #243: session default scope (incl. mid-session plur_session_scope
      // changes) establishes the remote dialing org context when no explicit
      // scope filter is passed.
      session: _resolveInjectionSession(args),
    })
    const response: Record<string, unknown> = {
      results: results.map(e => {
        const supersededBy = e.relations?.superseded_by
        const annotation = supersededBy?.length ? ` [superseded by ${supersededBy.join(', ')}]` : ''
        const raw = e as any
        // #869: surface measured_under so callers can see the measurement context.
        const measuredUnder: Record<string, string> | undefined = raw.measured_under
        const measuredAnnotation = measuredUnder
          ? ' [measured under: ' + Object.entries(measuredUnder)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ') + ']'
          : ''
        return {
          id: e.id,
          statement: e.statement + annotation + measuredAnnotation,
          type: e.type,
          scope: e.scope,
          domain: e.domain,
          retrieval_strength: e.activation.retrieval_strength,
          // SAME FACT, not same record (#852 follow-up). A stable SHA-256 of
          // the normalized statement: two engrams sharing it assert the same
          // thing, in different stores or under different ids. Use it to match
          // across stores and to spot a restatement you already hold — NOT as
          // an identifier. Statements mutate (UPDATE, MERGE, procedure
          // evolution), so this changes when the content does; `id` is what
          // stays fixed.
          content_hash: (e as { content_hash?: string }).content_hash,
          ...(measuredUnder ? { measured_under: measuredUnder } : {}),
        }
      }),
      count: results.length,
      mode: 'keyword',
    }
    attachRemoteStoreDegradation(response, plur)
    return response
  }
  // mode === 'hybrid' (default)
  const budget = args.budget as { max_tokens?: number; max_results?: number } | undefined
  const cap = budget?.max_results ?? (args.limit as number | undefined) ?? 20
  // When a max_results budget is set, fetch one extra so we can detect
  // whether the store had more results than the cap without over-fetching.
  // Without this, the search layer already caps at `cap` before we can
  // compare, so `results.length > cap` is always false (#725).
  const fetchLimit = budget?.max_results != null ? cap + 1 : cap
  const meta = await plur.recallHybridWithMeta(args.query as string, {
    scope: args.scope as string | undefined,
    domain: args.domain as string | undefined,
    limit: fetchLimit,
    remote_timeout_ms: 2000, // MCP recall remote budget (#776)
    // #243: session default scope (incl. mid-session plur_session_scope
    // changes) establishes the remote dialing org context when no explicit
    // scope filter is passed.
    session: _resolveInjectionSession(args),
  })
  // Opt-in, content-free engagement counter (default-off; no query text).
  recordTelemetry('recall')
  // Failed-recall miss-signal (WS5 demand flywheel) is emitted from the
  // core recallHybridWithMeta() this handler delegates to — it fires once
  // there for ALL consumers (MCP, claw, CLI, direct API), so we do NOT
  // re-emit here and double-count. It is opt-in/default-off and ships only
  // a query fingerprint hash + scope/domain + timestamp, never raw text.
  const truncatedByCount = budget?.max_results != null && meta.engrams.length > cap
  let truncated = truncatedByCount
  let boundedResults = truncatedByCount ? meta.engrams.slice(0, cap) : meta.engrams
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
      const supersededBy = (e as any).relations?.superseded_by
      const annotation = supersededBy?.length ? ` [superseded by ${supersededBy.join(', ')}]` : ''
      // #869: surface measured_under so callers can see the measurement context.
      const measuredUnder: Record<string, string> | undefined = raw.measured_under
      const measuredAnnotation = measuredUnder
        ? ' [measured under: ' + Object.entries(measuredUnder)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') + ']'
        : ''
      const base: Record<string, unknown> = {
        id: e.id,
        statement: e.statement + annotation + measuredAnnotation,
        type: e.type,
        scope: e.scope,
        domain: e.domain,
        retrieval_strength: e.activation.retrieval_strength,
        // Same fact, not same record — see the note on the other recall
        // formatter. Both shapes carry it or an agent gets it only sometimes.
        content_hash: raw.content_hash,
        ...(measuredUnder ? { measured_under: measuredUnder } : {}),
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
  // A4′ (#776): per-host remote degradation — attached only when non-ok.
  attachRemoteStoreDegradation(response, plur)
  return response
}

const RECALL_HYBRID_DEPRECATION =
  'plur_recall_hybrid is deprecated since 0.16 — use plur_recall (mode defaults to hybrid). This alias will be removed in 0.18.'

// Recursive JSON-Schema → Zod converter for tool input validation. Moved here
// (was previously private to server.ts) so plur_admin's dispatch handler can
// validate inner-tool args the same way the top-level CallToolRequestSchema
// handler does — one validator, not two copies that can drift (#231, #297).
function jsonSchemaPropToZod(prop: any): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object') return z.unknown()
  const variants = (prop.anyOf as any[] | undefined) ?? (prop.oneOf as any[] | undefined)
  if (Array.isArray(variants) && variants.length > 0) {
    const zodVariants = variants.map(jsonSchemaPropToZod)
    if (zodVariants.length === 1) return zodVariants[0]
    return z.union(zodVariants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  if (prop.type === 'string') return prop.enum ? z.enum(prop.enum) : z.string()
  if (prop.type === 'number' || prop.type === 'integer') return z.number()
  if (prop.type === 'boolean') return z.boolean()
  if (prop.type === 'array') {
    const itemSchema = prop.items ? jsonSchemaPropToZod(prop.items) : z.unknown()
    return z.preprocess((val) => {
      if (typeof val !== 'string') return val
      const trimmed = val.trim()
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed)
          return Array.isArray(parsed) ? parsed : val
        } catch {
          return val
        }
      }
      // The comma-separated fallback must also cover union item schemas that
      // ACCEPT a bare string, not just `items: {type: 'string'}`. Before this,
      // `engram_suggestions` — whose items are
      // `anyOf: [{type:'string'}, {type:'object'}]` (#231) — failed the check
      // and fell through to `return val`, so the very workaround the #297
      // error message advertises did not work for it.
      const items = prop.items as any
      const itemVariants = (items?.anyOf as any[] | undefined) ?? (items?.oneOf as any[] | undefined)
      const itemsAcceptString = items?.type === 'string'
        || (Array.isArray(itemVariants) && itemVariants.some((v: any) => v?.type === 'string'))

      if (itemsAcceptString) {
        return trimmed.length === 0 ? [] : trimmed.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      }
      return val
    }, z.array(itemSchema))
  }
  if (prop.type === 'object' && prop.properties) {
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [k, p] of Object.entries(prop.properties) as [string, any][]) {
      const field = jsonSchemaPropToZod(p)
      shape[k] = prop.required?.includes(k) ? field : field.optional()
    }
    return z.object(shape).passthrough()
  }
  return z.unknown()
}

/**
 * Validate raw tool-call arguments against a ToolDefinition's inputSchema.
 * Shared by the top-level CallToolRequestSchema handler (server.ts) and the
 * plur_admin dispatch handler below — one validation path AND one error-
 * formatting path, not two that can drift. (An earlier draft of this plan
 * only shared the Zod validation and left the #297 array-bug hint / isError
 * flag duplicated in server.ts alone — audit review caught that plur_admin's
 * ~30 dispatched tools would silently lose both. errorPayload below is the
 * fix: the full formatted error, including the `_isError` marker server.ts
 * checks generically after ANY tool handler returns, not just this one.)
 */
export function validateToolArgs(
  tool: ToolDefinition,
  rawArgs: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | {
  ok: false
  /**
   * Missing field NAMES that are array-typed. Sits OUTSIDE `errorPayload` so
   * the forensic log can separate the #297 array shape from a scalar-only miss
   * without adding a field to the client-visible error response.
   */
  missingArrayParams: string[]
  errorPayload: {
    error: string
    success: false
    received_fields: string[]
    missing_fields: string[]
    drop?: 'whole_payload' | 'partial'
    _isError: true
  }
} {
  const schema = tool.inputSchema as any
  if (!schema?.properties) return { ok: true, data: rawArgs }

  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
    const field = jsonSchemaPropToZod(prop)
    shape[key] = schema.required?.includes(key) ? field : field.optional()
  }
  const parsed = z.object(shape).passthrough().safeParse(rawArgs)
  if (!parsed.success) {
    const receivedFields = Object.keys(rawArgs)
    const details = parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join(', ')
    const hasArrayParam = Object.values((schema.properties ?? {}) as Record<string, any>)
      .some((p: any) => p?.type === 'array')

    // Field NAMES the schema expected but that did not arrive at all.
    const missingFields = parsed.error.issues
      .filter((i: any) => i.code === 'invalid_type' && i.received === 'undefined')
      .map((i: any) => String(i.path[0] ?? ''))
      .filter((k: string) => k.length > 0)

    // The drop has TWO shapes. The partial drop keeps the early scalar fields
    // and silently discards trailing ones — observed on a large payload where a
    // ~700-char `summary` plus a 5-element `engram_suggestions` array arrived
    // as `{summary}` alone (#297); that shape genuinely correlates with
    // array-typed fields, so the array-workaround hint stays on it.
    //
    // The WHOLE-payload drop was reclassified by #772 (refining #297): on
    // v0.16.1 field evidence it is NOT array-specific — scalar-only calls drop
    // too, an array-carrying call succeeds moments later, and the strongest
    // correlation is multiple tool_use blocks batched into one client message.
    // It is transient: retrying the IDENTICAL call succeeds. So the empty
    // branch no longer keys on the tool having an array param, and its
    // guidance is "retry the same payload, alone in the message" — not
    // "reshape your arrays": the payload was never evaluated, so there is
    // nothing in it to fix.
    const missingArrayParams = missingFields
      .filter((k: string) => (schema.properties as any)?.[k]?.type === 'array')

    const wholePayloadDrop = receivedFields.length === 0
    // Any partial arrival is recorded, not only one missing an array param.
    //
    // Gating on `missingArrayParams.length > 0` meant every partial drop in the
    // log involved an array BY CONSTRUCTION, so the log agreed with #297's
    // array hypothesis no matter what was true and could never test it — and
    // testing it is what #772 asks for. A scalar-only miss is usually an
    // ordinary caller error rather than a client drop, so the two populations
    // are separated by `missingArrayParams` on the record instead of by
    // excluding one of them from the evidence.
    const partialDrop = !wholePayloadDrop && missingFields.length > 0
    // What gets RECORDED and what gets EXPLAINED are now different questions.
    // The #297 hint tells a caller to reshape array params, which is wrong (and
    // misleading) advice for a scalar-only miss — that caller simply omitted a
    // field. So the hint stays keyed on an array actually being missing, while
    // the log records both populations.
    const arrayShapedDrop = partialDrop && missingArrayParams.length > 0

    let dropHint = ''
    if (wholePayloadDrop) {
      dropHint = ' Known intermittent client-side issue (plur-ai/plur#772, refines #297): some MCP ' +
        'clients transiently drop the ENTIRE arguments payload — most often when several tool calls ' +
        'are batched into a single message. Nothing was stored or evaluated. Retry the IDENTICAL ' +
        'call with the full payload, as the ONLY tool call in that message — identical retries ' +
        'typically succeed. If two identical retries fail the same way, the arguments really are ' +
        'absent from your call — re-issue it with the intended fields.' +
        (hasArrayParam
          ? ' If retries keep failing specifically on array parameters, pass them as a JSON string ' +
            '(e.g. tags: "[\\"a\\",\\"b\\"]") or a comma-separated string (tags: "a, b") — the server ' +
            'coerces both back into arrays.'
          : '')
    } else if (arrayShapedDrop) {
      dropHint = ' Known client-side bug (plur-ai/plur#297): some MCP clients drop ' +
        `array-typed parameters from a large arguments payload while keeping the earlier fields ` +
        `(here: ${missingArrayParams.join(', ')}). This is size-sensitive — the same call often ` +
        `succeeds with a shorter payload, so shrink the other fields (e.g. a briefer summary) as well. ` +
        'Retry passing array parameters as a JSON string ' +
        '(e.g. tags: "[\\"a\\",\\"b\\"]") or a comma-separated string (tags: "a, b") — the server coerces ' +
        'both back into arrays.'
    }

    const receivedNote = receivedFields.length > 0
      ? `Received fields: [${receivedFields.join(', ')}].`
      : 'Received no fields (the arguments object was empty).'
    const disposition = wholePayloadDrop
      ? 'The request reached the server but its arguments did not — do not abandon the call, and do ' +
        'not rewrite the payload: it was never evaluated. Retry the IDENTICAL call; it usually ' +
        'succeeds. If you issued several tool calls in one message, send them one per message — ' +
        'batching is the strongest correlate of this drop (#772).'
      : 'The call reached the server — this is a malformed-arguments error, not a transport failure. ' +
        'Fix the field(s) named above and retry; do not abandon the call.'
    return {
      ok: false,
      missingArrayParams,
      errorPayload: {
        error: `Invalid arguments: ${details}. ${receivedNote} ${disposition}${dropHint}`,
        success: false,
        received_fields: receivedFields,
        missing_fields: missingFields,
        ...(wholePayloadDrop
          ? { drop: 'whole_payload' as const }
          : partialDrop ? { drop: 'partial' as const } : {}),
        _isError: true,
      },
    }
  }
  return { ok: true, data: parsed.data as Record<string, unknown> }
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
- **plur_recall** — search engrams by topic (default: hybrid BM25 + embeddings; use mode:"keyword" for BM25-only)
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

/**
 * Session injection telemetry — tracks pack-level engram injection counts per
 * session. Keyed by session_id → map of pack_name → engram count.
 *
 * Data source for the 25-80 sessions/month activation-rate assumption. Surface
 * at plur_session_end so Michelle can validate with real data.
 *
 * The Map is process-scoped (one MCP server = one long-running process serving
 * sequential sessions). Entries are cleaned up when session_end runs, so memory
 * does not accumulate across sessions. A TTL guard caps memory if session_end
 * is never called (hook crash, forced kill, etc.).
 *
 * Structure: session_id → { pack_name → injection_count, __total_injections → N }
 * The __total_injections key counts how many inject calls happened (not engrams).
 */
interface SessionTelemetry {
  pack_counts: Record<string, number>
  /** Number of distinct inject calls (plur_session_start + plur_inject/hybrid). */
  injection_calls: number
  /** ISO timestamp of session_start — used for TTL cleanup. */
  started_at: string
  /**
   * Session-start default write scope (#243) — what `plur_session_scope`
   * op:"clear" reverts to. Recorded here (the existing session-keyed state)
   * rather than in a new process-global, per ADR-0004.
   */
  default_scope?: string | null
  /** How the session-start default was derived (#243). */
  default_scope_source?: 'caller' | 'project-config' | 'none'
  /** True while a mid-session plur_session_scope op:"set" is in effect (#243). */
  scope_adjusted?: boolean
}
const _sessionTelemetry = new Map<string, SessionTelemetry>()

/** TTL for unclosed sessions: 8 hours. Prevents unbounded memory if session_end is never called. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function _cleanExpiredSessions(plur?: Plur): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, state] of _sessionTelemetry) {
    if (new Date(state.started_at).getTime() < cutoff) {
      _sessionTelemetry.delete(id)
      // #243: evict the expired session's keyed scope registration alongside
      // its telemetry (only when a caller with a Plur instance triggered the
      // sweep — the id-only helpers pass nothing and the entry is cleared on
      // the next plur-bearing sweep or session_end).
      try { plur?.clearSessionScope({ session: id }) } catch { /* best-effort */ }
    }
  }
}

/**
 * The session an untagged `plur_inject` / `plur_inject_hybrid` call belongs to.
 *
 * This used to be a module-level `_activeSessionId`, assigned by session_start
 * and cleared by session_end, justified by "MCP sessions are sequential within
 * a process". Convergence Phase 2 removes that assumption: a deployment that
 * serves concurrent sessions from one process has overlapping session_start
 * calls, and the second one silently reassigns the variable — so an inject
 * belonging to session A is recorded against session B, and when A ends the
 * `if (_activeSessionId === session_id)` guard leaves the stale id in place.
 *
 * Derived, not stored, and only answered when it is UNAMBIGUOUS. With exactly
 * one session open the implicit attribution is correct and behaviour is
 * unchanged. With none or several, there is no right answer, and recording
 * nothing beats recording against the wrong session — telemetry that is
 * silently misattributed is worse than telemetry that is absent. Callers that
 * need attribution under concurrency pass `session_id` explicitly.
 */
function _implicitSessionId(): string | undefined {
  _cleanExpiredSessions()
  if (_sessionTelemetry.size !== 1) return undefined
  return _sessionTelemetry.keys().next().value
}

/**
 * Drop all session telemetry.
 *
 * The map is module-level, so it outlives any single `Plur` instance and leaks
 * between tests in one file. Exported as a test seam — and usable by an
 * embedding consumer that recycles the tool definitions across tenants — so
 * "which sessions are open" is a controllable input rather than whatever the
 * previous test happened to leave behind.
 */
export function _resetSessionTelemetry(): void {
  _sessionTelemetry.clear()
}

/** Resolve the session for an injection: explicit argument first, then implicit. */
function _resolveInjectionSession(args: Record<string, unknown>): string | undefined {
  const explicit = args.session_id
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return _implicitSessionId()
}

/**
 * Resolve the session a `plur_session_scope` operation targets (#243).
 *
 * Same derivation contract as `_implicitSessionId`: explicit `session_id`
 * always wins; with exactly one session open the implicit answer is
 * unambiguous; with none the process-default slot is the target (the
 * pre-session_start / hookless deployment). With SEVERAL open and no
 * explicit id there is no right answer — `ambiguous` is surfaced so writes
 * (set/clear) can refuse instead of silently landing in the process slot,
 * where one session's scope change would decide another session's writes
 * (the exact ADR-0004 failure).
 */
function _resolveScopeSession(args: Record<string, unknown>): { session?: string; ambiguous: boolean; open: number } {
  const explicit = args.session_id
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { session: explicit, ambiguous: false, open: _sessionTelemetry.size }
  }
  _cleanExpiredSessions()
  const open = _sessionTelemetry.size
  if (open === 1) return { session: _sessionTelemetry.keys().next().value, ambiguous: false, open }
  return { session: undefined, ambiguous: open > 1, open }
}

/** Record pack counts from an InjectionResult into the active session's telemetry. */
function _recordInjectionTelemetry(session_id: string | undefined, injected_packs: Record<string, number> | undefined): void {
  if (!session_id) return
  const state = _sessionTelemetry.get(session_id)
  if (!state) return

  // The CALL is counted whether or not it injected anything.
  //
  // This used to return early on `!injected_packs`, and core only builds that
  // object when at least one engram was injected — so an inject call that
  // matched nothing was not counted at all, while the field is named
  // `injection_calls` and documented as "number of distinct inject calls".
  //
  // The effect was load-bearing and intermittent: `session_start` injects for
  // the session's task, and if that task happens to match no engram (or if
  // `injectHybrid` falls back to BM25 because the embedding model is slow to
  // load, which is exactly what happens on a cold CI runner) the count silently
  // came up short. A telemetry counter that undercounts only when retrieval
  // does badly is worse than no counter: it biases the metric toward sessions
  // that went well.
  state.injection_calls++

  if (!injected_packs) return
  for (const [pack, count] of Object.entries(injected_packs)) {
    state.pack_counts[pack] = (state.pack_counts[pack] ?? 0) + count
  }
}

export type ToolProfile = 'full' | 'lean' | 'cursor'

// The day-to-day tools a Cursor user needs, plus every tool marked
// `destructiveHint: true` — everything else (packs install/list, sync,
// timeline, meta-engrams, ingest, capture, ...) is reachable through
// plur_admin instead of its own top-level tool slot. Cursor caps a workspace
// at ~40 MCP tools total across every server, and PLUR's full 43-tool
// surface alone would consume ~110% of that budget.
//
// Destructive tools are kept OUT of plur_admin's dispatch specifically
// (audit fix — evaluator review, 2026-07-08; ENFORCED in the handler since
// the 2026-07-24 lean audit — previously they were only omitted from the
// advertised list while byName still dispatched them): a client that gates
// confirmation prompts or audit trails off MCP tool annotations — the whole
// point of the annotations field — can no longer tell "delete a pack and
// all its engrams" apart from "check status" once both are wrapped behind
// the same generic dispatch tool, whose own single static annotation
// (`{ title: 'Admin dispatch', readOnlyHint: false }`) can't carry a
// per-action risk signal. The handler refuses any target with
// `destructiveHint: true` and points at the direct tool. Two more core
// tools (11 total) is still far under the ~40-tool cap, so there's no
// budget reason to wrap them either.
// Exported (audit fix — evaluator review, iteration 2, 2026-07-09) so
// server.ts's plur://guide resource can build its cursor-profile redirect
// note FROM this set instead of hardcoding a second, independent copy of
// the same tool list — two copies drift the moment one changes and nothing
// catches it, silently making the guide agents are told to read for the
// full reference wrong.
export const CURSOR_CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'plur_session_start',
  'plur_session_end',
  'plur_learn',
  'plur_recall',
  'plur_feedback',
  'plur_forget',
  'plur_status',
  'plur_receipt',
  'plur_doctor',
  'plur_packs_uninstall',
  'plur_tensions_purge',
])

/**
 * One line of a tool's description, for plur_admin's `help` action (#761).
 * Cuts at the first newline, then backs off to a sentence boundary when the
 * line runs long — the full detail stays on the tool definition itself.
 */
function summarizeToolDescription(description: string): string {
  const line = description.split('\n', 1)[0].trim()
  if (line.length <= 200) return line
  const cut = line.lastIndexOf('. ', 200)
  return cut > 40 ? line.slice(0, cut + 1) : `${line.slice(0, 199)}…`
}

/**
 * The action inventory clause for plur_admin's tool description, grouped by
 * name family (the token after `plur_`) so ~30 names scan as a categorized
 * list instead of a wall. GENERATED from the same action list the dispatcher
 * routes on — never hand-maintained (#761): hand-kept text is exactly what
 * drifts silently the moment a tool is added or renamed, and this description
 * is the one place a client that only reads tools/list can learn the surface.
 *
 * If the registry ever outgrows what a description can reasonably carry, the
 * clause degrades to family names + counts and points at `help` — a truncated
 * enumeration reads as complete, which is worse than an honest summary.
 */
function describeActionInventory(actions: string[]): string {
  const families = new Map<string, string[]>()
  for (const name of actions) {
    const family = name.replace(/^plur_/, '').split('_', 1)[0]
    families.set(family, [...(families.get(family) ?? []), name])
  }
  const sorted = [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const grouped: string[] = []
  const misc: string[] = []
  for (const [family, members] of sorted) {
    if (members.length > 1) grouped.push(`${family}: ${members.join(', ')}`)
    else misc.push(members[0])
  }
  if (misc.length > 0) grouped.push(`other: ${misc.join(', ')}`)
  const full = `Actions, grouped — ${grouped.join(' · ')}.`
  if (full.length <= 1500) return full
  const counted = sorted.map(([family, members]) => `${family} (${members.length})`).join(', ')
  return `${actions.length} actions in groups ${counted} — the full list is in { action: "help" }.`
}

function buildAdminDispatchTool(all: ToolDefinition[]): ToolDefinition {
  const byName = new Map(all.map(t => [t.name, t] as const))
  const adminActions = all.map(t => t.name).filter(n => !CURSOR_CORE_TOOL_NAMES.has(n)).sort()
  // The example an agent copies must be a real, currently-dispatchable action —
  // prefer the one from the #761 incident report, fall back to whatever exists.
  const exampleAction = adminActions.includes('plur_recall_hybrid') ? 'plur_recall_hybrid' : adminActions[0]
  const exampleArgs = exampleAction === 'plur_recall_hybrid' ? '{ query: "deploy checklist" }' : '{}'

  return {
    name: 'plur_admin',
    description:
      `Gateway to the ${adminActions.length} PLUR operations that are not top-level tools under the ` +
      "current profile (collapsed into one dispatch tool so Cursor's ~40-tool-per-workspace limit is " +
      'not exhausted by PLUR alone). A plur_* name missing from tools/list means it moved HERE — not ' +
      'that the MCP is unavailable. Calling convention: { action: "<tool name>", args: { ...that ' +
      "tool's normal arguments } } — same arguments, same validation, same result as a direct call. " +
      `Example: { action: "${exampleAction}", args: ${exampleArgs} }. Send { action: "help" } for ` +
      `every action's one-line description and argument schema. ${describeActionInventory(adminActions)}`,
    annotations: { title: 'Admin dispatch', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        // No `enum` here — an invalid action must reach the handler's custom
        // Unknown-action message with the full valid-actions list, not fail
        // at top-level schema validation with a generic "Invalid arguments"
        // error. If `enum: adminActions` were set, the top-level
        // CallToolRequestSchema handler's Zod validation would reject
        // unknown actions before this handler's `if (!target)` branch ever
        // ran.
        action: { type: 'string', description: 'Which underlying plur_* tool to invoke, or "help" to list every action with its description and argument schema' },
        args: { type: 'object', description: "Arguments for the chosen action, matching that tool's normal input schema", additionalProperties: true },
      },
      required: ['action'],
    },
    handler: async (args, plur) => {
      const action = args.action as string
      // #761: the runtime discovery surface. The tool description carries the
      // action NAMES; this returns what each one does and what it takes, so an
      // agent that only knows "plur_admin exists" can learn the whole surface
      // in one call instead of guessing names against the Unknown-action error.
      if (action === 'help') {
        return {
          calling_convention:
            'plur_admin { action: "<tool name>", args: { ... } } — same arguments, same validation, ' +
            'same result as calling that tool directly. A tools/list miss on one of these names means ' +
            'it is consolidated here, NOT that the MCP is unavailable.',
          actions: adminActions.map(name => {
            const t = byName.get(name)!
            return { action: name, description: summarizeToolDescription(t.description), args_schema: t.inputSchema }
          }),
          standalone_tools: all.map(t => t.name).filter(n => CURSOR_CORE_TOOL_NAMES.has(n)).sort(),
          standalone_note:
            'standalone_tools are exposed as top-level tools in every profile — call them directly, ' +
            'never through plur_admin (destructive ones are refused here so their risk annotations ' +
            'stay visible to your client).',
        }
      }
      const target = byName.get(action)
      if (!target) {
        return { error: `Unknown action "${action}". Valid actions: help, ${adminActions.join(', ')}`, success: false, _isError: true }
      }
      // #625 audit: ENFORCE the annotation-visibility guarantee the module
      // comment documents. Destructive tools must never execute through this
      // generic dispatch — plur_admin's single static annotation carries no
      // per-action risk signal, so a client gating confirmation prompts on
      // `destructiveHint` would silently lose that gate for a wrapped call.
      // Every destructive tool is in CURSOR_CORE_TOOL_NAMES (directly
      // callable in every profile, with its real annotations), so refusing
      // dispatch loses nothing. Keyed off destructiveHint, not a name list,
      // so future destructive tools are protected automatically.
      if (target.annotations?.destructiveHint === true) {
        return {
          error: `"${action}" is a destructive operation and cannot be dispatched via plur_admin — call the ${action} tool directly (it is exposed in every profile) so your client sees its destructiveHint annotation.`,
          success: false,
          _isError: true,
        }
      }
      const innerArgs = (args.args as Record<string, unknown>) ?? {}
      const validated = validateToolArgs(target, innerArgs)
      if (!validated.ok) {
        // Reuse the exact same formatted error server.ts would produce for a
        // direct call to `target` — prefix with the action name so it's clear
        // which dispatched tool rejected the args, but keep the #297 hint,
        // received_fields, and _isError marker intact (audit fix — see
        // validateToolArgs's docstring).
        return { ...validated.errorPayload, error: `${action}: ${validated.errorPayload.error}` }
      }
      try {
        return await target.handler(validated.data, plur)
      } catch (err: unknown) {
        // Audit fix (evaluator review, 2026-07-08): an uncaught throw from
        // the wrapped handler propagates up to server.ts's top-level catch,
        // which logs `Tool ${request.params.name} failed: ...` —
        // request.params.name is always "plur_admin" at the protocol level,
        // so without this the log can never say which of the ~31 wrapped
        // operations actually broke. Prefixing the action name here means
        // it survives into that log message even though the tool name doesn't.
        const message = (err as Error)?.message ?? String(err)
        throw new Error(`${action}: ${message}`)
      }
    },
  }
}

/** Profile from the environment. The default when nobody says otherwise. */
export function resolveToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const v = env.PLUR_TOOL_PROFILE
  return v === 'full' ? 'full' : v === 'cursor' ? 'cursor' : 'lean'
}

/**
 * The profile the running server was ACTUALLY built with.
 *
 * `createServer` takes an explicit `profile` option, so the environment is not
 * the authority — `createServer(plur, { profile: 'full' })` with no env var set
 * exposes 41 tools while `resolveToolProfile()` still says `lean`. Reporting
 * the env-derived value would make plur_doctor describe a 12-tool surface to a
 * client looking at 41: confidently wrong, in the one field the client has no
 * way to check. Left unset it falls back to the environment, which is right for
 * anything that has not gone through `createServer`.
 */
let activeProfile: ToolProfile | null = null

/** Record the profile a server was constructed with. Called by `createServer`. */
export function setActiveToolProfile(profile: ToolProfile): void {
  activeProfile = profile
}

/** Test seam — forget the recorded profile. */
export function _resetActiveToolProfile(): void {
  activeProfile = null
}

/** The profile in force: what the server was built with, else the environment. */
export function activeToolProfile(): ToolProfile {
  return activeProfile ?? resolveToolProfile()
}

/**
 * The tool surface as the client actually sees it, for a given profile.
 *
 * Exists because a consolidated surface is invisible to a client that only
 * reads `tools/list` (#761). Under the lean profile most `plur_*` tools are no
 * longer standalone — they are actions on `plur_admin` — so an agent carrying a
 * memory of the old names looks one up, misses, and concludes the MCP is down.
 * It never calls the missing name, so the helpful "call it via plur_admin"
 * error on that path never fires.
 *
 * The observed failure (2026-07-29) is the sharp version: `plur_doctor`
 * reported green while the agent switched to an HTTP fallback, because doctor
 * answers "is the engine healthy" and the actual question was "what is
 * callable". Health and surface are different questions, and only one of them
 * was answerable in-band.
 */
export function describeToolSurface(profile: ToolProfile = activeToolProfile()): {
  profile: ToolProfile
  standalone: string[]
  admin_actions: string[]
  note: string
} {
  const all = getAllToolDefinitions()
  const exposed = getToolDefinitions(profile)
  const standalone = exposed.map(t => t.name).sort()
  const admin_actions = profile === 'full'
    ? []
    : all.map(t => t.name).filter(n => !CURSOR_CORE_TOOL_NAMES.has(n)).sort()
  return {
    profile,
    standalone,
    admin_actions,
    note: admin_actions.length === 0
      ? 'All tools are exposed directly under this profile.'
      : `Only the ${standalone.length} tools in "standalone" are callable by name. Everything in "admin_actions" is reachable as plur_admin { action: "<name>", args: {...} } — same arguments, same validation, same result. A name-lookup miss on one of those means it moved, NOT that the MCP is unavailable. Call plur_admin { action: "help" } for each action's description and argument schema. Set PLUR_TOOL_PROFILE=full to expose all tools directly.`,
  }
}

export function getToolDefinitions(profile: ToolProfile = 'lean'): ToolDefinition[] {
  const all = getAllToolDefinitions()
  if (profile === 'full') return all
  // 'lean' and 'cursor' are identical: 11 core tools + plur_admin dispatch (12 exposed)
  const core = all.filter(t => CURSOR_CORE_TOOL_NAMES.has(t.name))
  return [...core, buildAdminDispatchTool(all)]
}

/**
 * One-line, honest framing of a Receipt for the calling agent — carries the
 * same guardrail the CLI renders, so an agent never presents the coverage-style
 * activation_rate as an effectiveness score.
 */
function receiptSummary(r: Receipt): string {
  if (r.coverage.source === 'none') {
    return r.window.windowed
      ? `No retrievals recorded in the last ${r.window.requested_days} days.`
      : 'No retrieval history yet — logging begins once memory is used.'
  }
  const since = r.window.windowed
    ? `the last ${r.window.requested_days} days`
    : `${r.coverage.complete_from}`
  const pct = Math.round(r.retrieved.activation_rate * 100)
  return (
    `Since ${since}, ${r.retrieved.taught_pairs} times a memory the user taught was ` +
    `retrieved into context (across ${r.retrieved.retrievals} retrievals in ` +
    `${r.window.sessions} sessions; ${r.retrieved.engrams} distinct engrams). ` +
    `Activation ${pct}% is store COVERAGE over the logging window, not a quality ` +
    `score — it is expected to be low and to fall as more engrams are added.`
  )
}

function getAllToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'plur_learn',
      description:
        'Create an engram — record a reusable learning, preference, or correction. ' +
        'A write is never suppressed by similarity: exact content-hash duplicates NOOP, and anything merely SIMILAR ' +
        'is written and reported back in `dedup.near_duplicates` (closest existing engrams and their cosine scores) ' +
        'so you can supersede or merge deliberately. High similarity is a reason to look, not a decision — cosine ' +
        'cannot tell a duplicate from a correction of it. ' +
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
          commitment: { type: 'string', enum: ['exploring', 'leaning', 'decided', 'locked', 'draft'], description: 'How firmly the user has committed to this belief (default: leaning). `draft` marks the engram as pending human approval — core stores and recalls it normally; enforcement is left to deployments with a review queue.' },
          locked_reason: { type: 'string', description: 'Why this engram is locked (only meaningful when commitment=locked)' },
          valid_from: { type: 'string', description: 'ISO date (YYYY-MM-DD) the knowledge becomes valid — inject/recall skip the engram before this date (#347)' },
          valid_until: { type: 'string', description: 'ISO date (YYYY-MM-DD) the knowledge expires — inject/recall skip the engram after this date. Set this for any time-bound fact (offers, deadlines, temporary endpoints). When omitted, an explicit expiry phrase in the statement ("valid until 31 May 2026") is auto-parsed and echoed back (#347)' },
          supersedes: { type: 'array', items: { type: 'string' }, description: 'Engram IDs this statement intentionally replaces (#240). Writes relations.supersedes on the new engram and the reverse superseded_by edge on each local target. Supersedes-linked pairs are skipped by tension scans — an intentional update is not a contradiction. Use when updating a standing fact (new version, changed rule) rather than contradicting it.' },
          session_id: { type: 'string', description: 'Session this write belongs to (from plur_session_start). Resolves the session default scope (incl. mid-session plur_session_scope changes) when no explicit scope is passed. Optional when one session is open; pass it when several are (#243).' },
          measured_under: {
            type: 'object',
            description: 'Measurement context for numeric or benchmark-derived claims (#869). Records the conditions under which the asserted value was measured — model, source_type, hardware, dataset, date. When present, differing-condition measurements are stored as refinements rather than tensions. Omit for non-numeric engrams.',
            properties: {
              model: { type: 'string', description: 'Model or system variant (e.g. "claude-opus-4", "gpt-4o")' },
              source_type: { type: 'string', description: 'Source environment type (e.g. "local-git", "gitlab", "bench", "production")' },
              hardware: { type: 'string', description: 'Hardware or runtime tier (e.g. "M3-Pro-36GB", "A100", "CI-runner")' },
              dataset: { type: 'string', description: 'Dataset or workload identifier (e.g. "LongMemEval-S", "plur-bench-2026-Q2")' },
              date: { type: 'string', description: 'ISO date (YYYY-MM-DD) the measurement was taken' },
            },
          },
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
          supersedes: args.supersedes as string[] | undefined,
          measured_under: args.measured_under as Record<string, string> | undefined,
          // #243/#1048: one field, both jobs. It resolves which session's
          // default scope governs this write (explicit session_id first, else
          // the lone open session) AND is recorded in sources[].session_id so
          // the engram carries which session produced it.
          //
          // This used to map into `context.session`, a second field with the
          // same value and a different consumer, which left the provenance
          // field null on every shipping path.
          session_id: _resolveInjectionSession(args),
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

        // Missing-domain nudge (#671): the domain-prefix channel is the only
        // routing signal that reliably clears the auto-route threshold — an
        // engram written without a `domain` is unroutable by construction and
        // falls to the personal default no matter what the covers say. Fire
        // only when routing was actually on the table: no explicit scope, the
        // write did NOT auto-route anyway, and at least one registered scope
        // declares covers to route against. Personal installs with no
        // covers-bearing scopes stay silent.
        const domainHint = (wasRouted: boolean): { domain_hint?: string } => {
          if (typeof args.domain === 'string' && args.domain.length > 0) return {}
          if (explicitScope || wasRouted) return {}
          let coversScopes: string[] = []
          try {
            coversScopes = plur.listScopeMetadata()
              .filter(md => (md.covers?.length ?? 0) > 0)
              .map(md => md.scope)
          } catch { return {} }
          if (coversScopes.length === 0) return {}
          return { domain_hint:
            `No domain set — without a dotted domain this engram cannot auto-route to a covers-declaring scope ` +
            `(${coversScopes.join(', ')}) and is harder to re-scope later. Set domain on every plur_learn, ` +
            `shape "<org>.<team>.<area>" (e.g. "plur.engineering.mcp") — see the domain convention in CLAUDE.md.` }
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
          // Near-duplicate REPORTING (#856). This path only ever had exact
          // content-hash dedup — learnAsync, and with it the similarity pass,
          // is reachable solely from plur_learn_batch — so the dominant write
          // path had no near-duplicate visibility, which is how #854 happened
          // on it. Reporting only: never blocks or alters the write, and runs
          // after it so a reporting failure cannot cost a memory.
          const dedup = isOutbox
            ? undefined
            : await plur.nearDuplicates(statement, context, engram.id)
          return {
            // #914: report the id in the form plur_recall hands back, so a
            // caller that records what it just learned and passes it to
            // plur_feedback / plur_forget is holding an id shape the read side
            // actually produces. An outbox engram is excluded: it is sitting in
            // the LOCAL store under a local id until the retry lands, and that
            // is the id recall returns for it.
            id: isOutbox ? engram.id : plur.readIdFor(engram), statement: engram.statement,
            scope: engram.scope, type: engram.type,
            pinned: (engram as any).pinned === true,
            // See the note on recall results: same fact, not same record.
            content_hash: (engram as { content_hash?: string }).content_hash,
            decision: 'ADD',
            ...(dedup?.near_duplicates?.length ? { dedup } : {}),
            ...temporalEcho(engram),
            ...scopeHint(engram.scope, !!routed),
            ...domainHint(!!routed),
            ...(isOutbox ? { outbox: true, warning: 'Remote write failed; engram queued locally for retry on next session start or plur_sync.' } : {}),
            ...(demoted ? { demoted: true, requested_scope: demoted.from, warning: `Sensitive content (${demoted.patterns}) detected — stored at "${demoted.to}"/private instead of the requested shared scope "${demoted.from}". If this is a false positive, re-scope deliberately.` } : {}),
            ...(routed ? { routed: { scope: routed.scope, confidence: routed.confidence, reason: routed.reason }, info: `No scope was provided; auto-routed to "${routed.scope}" (confidence ${routed.confidence}) because its content matched that scope's covers. Pass an explicit scope to override.` } : {}),
          }
        } catch (err) {
// learnRouted now saves to outbox on remote failure, so this
          // path should rarely be reached. Keep as defense-in-depth.
          const engram = await plur.learn(statement, context)
          const isOutbox = !!(engram as any).structured_data?._outbox
          const routedFallback = (engram as any).structured_data?._routed as { scope: string; confidence: number; reason: string } | undefined
          mcpCanary.signal('learn_activity')
          // Opt-in, content-free engagement counter (default-off; no statement text).
          recordTelemetry('learn')
          return {
            // Mirror the happy-path fix (#914): report the namespaced form so a
            // caller holding this id can pass it to plur_forget / plur_feedback
            // without hitting the collision the id form mismatch causes.
            // Outbox engrams stay local-form (same rule as line 1149).
            id: isOutbox ? engram.id : plur.readIdFor(engram), statement: engram.statement,
            scope: engram.scope, type: engram.type, decision: 'ADD',
            ...temporalEcho(engram),
            ...scopeHint(engram.scope, !!routedFallback),
            ...domainHint(!!routedFallback),
            ...(isOutbox ? { outbox: true } : {}),
            warning: `Remote write failed (${(err as Error).message}); engram queued for retry.`,
          }
        }
      },
    },

    {
      name: 'plur_learn_batch',
      description:
        'Create many engrams in one call — the batch form of plur_learn. Accepts an array of engram objects and ' +
        'writes them sequentially through the SAME dedup + policy pipeline as plur_learn (content-hash NOOP → semantic ' +
        'recall → LLM ADD/UPDATE/MERGE decision, or local cosine REPORTING when no LLM is configured). Exact-hash dedup ' +
        'also applies WITHIN the batch: a statement duplicating an earlier item in the same array resolves to NOOP ' +
        'against it. Similarity never suppresses a write — each result carries `dedup.mode` (llm | cosine | hash-only) ' +
        'and, when similarity ran, `dedup.near_duplicates`. Read dedup.mode before trusting an ADD: hash-only means ' +
        '"not identical", NOT "not a duplicate". Returns `ids` aligned 1:1 with the input array ' +
        '(ids[i] is the engram id for input i, or null if input i failed), the per-item decisions (each carrying its ' +
        'input_index), aggregate stats, and any per-item failures (each with its input index) — a single bad item ' +
        'does not abort the batch. Use this when an orchestration fans out and wants to persist consolidated findings without N ' +
        'separate calls. LLM dedup calls are capped (default 50, override with max_llm_calls) to bound bulk-import cost. ' +
        'Note: unlike plur_learn, batch items take the LOCAL learn path — remote-scope auto-routing (learnRouted) is ' +
        'not applied per item, so for shared/remote-store writes prefer plur_learn or pass an explicit local scope. ' +
        'See plur-ai/plur#281.',
      annotations: { title: 'Learn (batch)', destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          engrams: {
            type: 'array',
            description: 'Engram objects to persist. Each requires `statement`; the other fields mirror plur_learn.',
            items: {
              type: 'object',
              properties: {
                statement: { type: 'string', description: 'The knowledge assertion to store' },
                type: { type: 'string', enum: ['behavioral', 'terminological', 'procedural', 'architectural'], description: 'Category of the engram' },
                scope: { type: 'string', description: 'Namespace, e.g. global, project:myapp' },
                domain: { type: 'string', description: 'Domain tag, e.g. software.deployment' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Searchable keyword tags — contribute to BM25/embedding recall' },
                rationale: { type: 'string', description: 'Why this knowledge matters — also enters the search corpus' },
                source: { type: 'string', description: 'Origin of this knowledge (URL, conversation ref, etc.)' },
                pinned: { type: 'boolean', description: 'Always-load flag. Use sparingly: meta-rules, safety conventions, core principles.' },
                commitment: { type: 'string', enum: ['exploring', 'leaning', 'decided', 'locked', 'draft'], description: 'How firmly the user has committed (default: leaning). `draft` marks the engram as pending human approval — core stores and recalls it normally; enforcement is left to deployments with a review queue.' },
                valid_from: { type: 'string', description: 'ISO date (YYYY-MM-DD) the knowledge becomes valid' },
                valid_until: { type: 'string', description: 'ISO date (YYYY-MM-DD) the knowledge expires' },
                measured_under: {
                  type: 'object',
                  description: 'Measurement context for numeric/benchmark claims (#869). Fields: model, source_type, hardware, dataset, date.',
                  properties: {
                    model: { type: 'string' },
                    source_type: { type: 'string' },
                    hardware: { type: 'string' },
                    dataset: { type: 'string' },
                    date: { type: 'string' },
                  },
                },
              },
              required: ['statement'],
            },
          },
          max_llm_calls: { type: 'number', description: 'Max LLM dedup calls across the whole batch (default 50). Once spent, remaining items fall back to the local cosine path (no API cost); the dedup.mode on each result says which ran. Pass a large number to opt out.' },
        },
        required: ['engrams'],
      },
      handler: async (args, plur) => {
        const llm = getLlmFunction()
        const raw = Array.isArray(args.engrams) ? (args.engrams as Array<Record<string, any>>) : []
        if (raw.length === 0) {
          return { ids: [], results: [], stats: { added: 0, updated: 0, merged: 0, noops: 0, failed: 0 }, failures: [], warning: 'No engrams provided — pass a non-empty `engrams` array.' }
        }
        const items = raw.map((e) => ({
          statement: sanitizeStatement(e.statement as string),
          context: {
            type: e.type,
            scope: e.scope as string | undefined,
            domain: e.domain as string | undefined,
            source: e.source as string | undefined,
            tags: e.tags as string[] | undefined,
            rationale: e.rationale as string | undefined,
            commitment: e.commitment,
            pinned: e.pinned as boolean | undefined,
            valid_from: e.valid_from as string | undefined,
            valid_until: e.valid_until as string | undefined,
            measured_under: e.measured_under as Record<string, string> | undefined,
            // Batch writes are session writes too — without this every engram
            // from plur_learn_batch lands with sources[].session_id null.
            session_id: _resolveInjectionSession(args),
          },
        }))
        const maxLlmCalls = typeof args.max_llm_calls === 'number' ? args.max_llm_calls : undefined
        const { results, stats, failures } = await plur.learnBatch(
          items,
          llm,
          maxLlmCalls !== undefined ? { maxLlmCalls } : undefined,
        )
        mcpCanary.signal('learn_activity')
        // Opt-in, content-free engagement counter (default-off; no statement text).
        recordTelemetry('learn')
        // `ids` is aligned 1:1 with the INPUT array: ids[i] is the engram id for
        // input i, or null if input i failed (see failures[]). Previously this
        // was `results.map(r => r.engram.id)` — a COMPACTED array, so after a
        // mid-batch failure every subsequent id shifted left and mis-attributed
        // to the wrong input (#281). Build from input_index instead.
        //
        // #930/#914 parity: report ids in the namespaced form plur_recall returns,
        // matching the fix applied to plur_learn in b93fa8e. An outbox engram is
        // excluded — it sits in the LOCAL store under a local id until the retry
        // lands, and that is what recall returns for it.
        const ids: (string | null)[] = raw.map(() => null)
        for (const r of results) {
          if (r.input_index !== undefined) {
            const isOutbox = !!(r.engram as any).structured_data?._outbox
            ids[r.input_index] = isOutbox ? r.engram.id : plur.readIdFor(r.engram)
          }
        }
        // Missing-domain nudge (#671), batch form: aggregate count instead of a
        // per-item echo. Same gate as plur_learn — only items that passed
        // neither a domain nor an explicit scope, and only when at least one
        // registered scope declares covers to route against.
        let batchDomainHint: { domain_hint?: string } = {}
        // Parity with the single-item gate (#681). That gate has FOUR
        // conditions, and this one had three: it counted an item as
        // "no domain, no scope" without asking whether it nonetheless
        // AUTO-ROUTED. A no-domain item reaches the ranker's 0.5 threshold on
        // three matching tags alone (3 × WEIGHT_TAG = 1.5, the same total a
        // domain match scores), and when it does the single-item path stays
        // silent — so the same write produced a nudge in a batch and none on
        // its own. Advisory either way, but a hint that contradicts itself
        // depending on which call shape you used is worse than no hint.
        //
        // `_routed` is per-RESULT, not per-input, so the routed set is built
        // from `results` and mapped back through `input_index` — the same
        // alignment `ids` above needs, and for the same reason: `results` is
        // compacted past failures.
        const routedInputs = new Set<number>()
        for (const r of results) {
          const routed = (r.engram as { structured_data?: { _routed?: unknown } }).structured_data?._routed
          if (routed !== undefined && r.input_index !== undefined) routedInputs.add(r.input_index)
        }
        const noDomainCount = raw.filter((e, i) =>
          !(typeof e.domain === 'string' && e.domain.length > 0) &&
          !(typeof e.scope === 'string' && e.scope.length > 0) &&
          !routedInputs.has(i)).length
        if (noDomainCount > 0) {
          try {
            const coversScopes = plur.listScopeMetadata()
              .filter(md => (md.covers?.length ?? 0) > 0)
              .map(md => md.scope)
            if (coversScopes.length > 0) {
              batchDomainHint = { domain_hint:
                `${noDomainCount} of ${raw.length} item(s) had no domain and no explicit scope — they cannot ` +
                `auto-route to a covers-declaring scope (${coversScopes.join(', ')}) and are harder to re-scope ` +
                `later. Set domain on every item, shape "<org>.<team>.<area>" — see the domain convention in CLAUDE.md.` }
            }
          } catch { /* advisory only — never fail the batch over a hint */ }
        }
        return {
          ids,
          results: results.map((r) => {
            const isOutbox = !!(r.engram as any).structured_data?._outbox
            return {
            input_index: r.input_index,
            id: isOutbox ? r.engram.id : plur.readIdFor(r.engram),
            statement: r.engram.statement,
            scope: r.engram.scope,
            type: r.engram.type,
            decision: r.decision,
            ...(r.existing_id ? { existing_id: r.existing_id } : {}),
            // #856 audit: `dedup` was computed and then dropped here, so the
            // reporting it exists for reached no caller — "anything below the
            // bar is still reported" was not observable anywhere.
            ...(r.dedup ? { dedup: r.dedup } : {}),
          }
          }),
          stats,
          ...batchDomainHint,
          ...(failures.length > 0
            ? { failures, warning: `${failures.length} of ${raw.length} engram(s) failed to persist; the rest were written.` }
            : {}),
        }
      },
    },

    {
      name: 'plur_recall',
      description: 'Search engrams by topic. Default mode is hybrid (BM25 + local embeddings via RRF) — set mode:"keyword" for BM25-only. Local search plus, when a configured enterprise store is part of the current project/work, one live timeout-bounded recall per remote host merged in (a `remote_stores` block + warning appears when a host is degraded; no host configured or implicated = fully local). Note: a project-scope filter also returns personal-family engrams (local, global, user:*, agent:*); an explicit scope=global recall returns ALL personal-family engrams — wider than scope=global INJECT, which is targeted to the global namespace only.',
      annotations: { title: 'Recall', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant engrams' },
          mode: { type: 'string', enum: ['hybrid', 'keyword'], description: 'Search mode — hybrid (default): BM25 + embeddings via RRF; keyword: BM25-only (faster, embeddings-independent). budget, caller_session_id and include_episodes apply to hybrid mode only — in keyword mode use limit to bound results.' },
          scope: { type: 'string', description: 'Filter by scope (also includes global)' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          // `ttl_seconds` was declared here and never read (#703). A schema
          // field an agent can set and no handler consults is a lie the tool
          // tells about itself — it reads as "caching is configurable" and
          // nothing caches. Removed rather than documented: there is no
          // behaviour to describe, and describing "accepted and ignored"
          // still costs every caller a decision.
          budget: { type: 'object', description: 'Budget constraints for sub-agents. Hybrid mode only — ignored when mode:"keyword".', properties: { max_tokens: { type: 'number' }, max_results: { type: 'number' } } },
          caller_session_id: { type: 'string', description: 'Session ID of calling agent for budget enforcement. Hybrid mode only — ignored when mode:"keyword".' },
          include_episodes: { type: 'boolean', description: 'If true, include linked episode summaries for each engram (SP2 episodic anchoring). Hybrid mode only — ignored when mode:"keyword".' },
          session_id: { type: 'string', description: 'Session this recall belongs to (from plur_session_start). Its default scope (incl. mid-session plur_session_scope changes) sets the remote dialing context when no explicit scope filter is passed. Optional when one session is open (#243).' },
        },
        required: ['query'],
      },
      handler: recallHandler,
    },

    {
      name: 'plur_recall_hybrid',
      description: '[Deprecated since 0.16 — use plur_recall (mode defaults to hybrid). Alias kept for backwards compatibility; removal earliest 0.18.] Hybrid search — BM25 + local embeddings merged via Reciprocal Rank Fusion, plus the live enterprise-store recall leg when one is configured and project-relevant.',
      annotations: { title: 'Recall (hybrid) [deprecated alias]', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant engrams' },
          scope: { type: 'string', description: 'Filter by scope (also includes global)' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          budget: { type: 'object', description: 'Budget constraints for sub-agents', properties: { max_tokens: { type: 'number' }, max_results: { type: 'number' } } },
          caller_session_id: { type: 'string', description: 'Session ID of calling agent for budget enforcement' },
          include_episodes: { type: 'boolean', description: 'If true, include linked episode summaries for each engram (SP2 episodic anchoring)' },
          session_id: { type: 'string', description: 'Session this recall belongs to (from plur_session_start). Its default scope sets the remote dialing context when no explicit scope filter is passed (#243).' },
        },
        required: ['query'],
      },
      // True forwarder — delegates to the canonical plur_recall handler and
      // prepends the deprecation notice. No duplicated budget/episode/
      // reranker logic, so a fix to plur_recall reaches this alias too.
      handler: async (args, plur) => {
        const result = await recallHandler({ ...args, mode: 'hybrid' }, plur)
        return { deprecated: RECALL_HYBRID_DEPRECATION, ...(result as Record<string, unknown>) }
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
          session_id: { type: 'string', description: 'Session this injection belongs to (from plur_session_start). Optional when one session is open; required for correct attribution when several are.' },
        },
        required: ['task'],
      },
      handler: async (args, plur) => {
        const session_id = _resolveInjectionSession(args)
        const result = await plur.inject(args.task as string, {
          budget: args.budget as number | undefined,
          scope: args.scope as string | undefined,
          source: 'inject',
          session_id,
        })
        _recordInjectionTelemetry(session_id, result.injected_packs)
        return {
          directives: result.directives,
          consider: result.consider,
          count: result.count,
          tokens_used: result.tokens_used,
          injected_ids: result.injected_ids,
          // #181: unresolved-tension warnings — flag contradicted context
          ...(result.warnings ? { warnings: result.warnings } : {}),
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
          session_id: { type: 'string', description: 'Session this injection belongs to (from plur_session_start). Optional when one session is open; required for correct attribution when several are.' },
        },
        required: ['task'],
      },
      handler: async (args, plur) => {
        const session_id = _resolveInjectionSession(args)
        const result = await plur.injectHybrid(args.task as string, {
          budget: args.budget as number | undefined,
          scope: args.scope as string | undefined,
          source: 'inject',
          session_id,
        })
        _recordInjectionTelemetry(session_id, result.injected_packs)
        const response: Record<string, unknown> = {
          directives: result.directives,
          consider: result.consider,
          count: result.count,
          tokens_used: result.tokens_used,
          injected_ids: result.injected_ids,
          mode: 'hybrid',
          // #181: unresolved-tension warnings — flag contradicted context
          ...(result.warnings ? { warnings: result.warnings } : {}),
        }
        // A4′ (#776): per-host remote degradation — only when non-ok.
        attachRemoteStoreDegradation(response, plur)
        return response
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
          scope: {
            type: 'string',
            description: 'Store scope to target directly, e.g. "primary" for the local store or a remote scope like "group:plur/plur-ai/engineering". Required when the same engram ID exists in multiple stores (#850).',
          },
          signals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Engram ID' },
                signal: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                scope: { type: 'string', description: 'Store scope to target directly (optional, same semantics as top-level scope).' },
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
          for (const { id, signal, scope } of args.signals as Array<{ id: string; signal: 'positive' | 'negative' | 'neutral'; scope?: string }>) {
            try {
              await plur.feedback(id, signal, scope)
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
          await plur.feedback(args.id as string, args.signal as 'positive' | 'negative' | 'neutral', args.scope as string | undefined)
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
          const pinned = await plur.listPinned()
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
          scope: { type: 'string', description: 'Which store holds it (#831). Ids are minted per store, so one id can name several unrelated engrams. Pass "primary" to stay on disk — the local primary store and any local secondary stores, never a remote — or a remote scope (e.g. "group:plur/plur-ai/engineering") to target that server. A scope matching no configured store is rejected, not guessed at. Omit it and an id resolving in two places is refused.' },
        },
      },
      handler: async (args, plur) => {
        if (args.id) {
          const scope = args.scope as string | undefined
          // getById resolves first-match-wins across stores, so on a colliding
          // id it can return — and then report as retired — an engram that is
          // not the one forget() acts on (#831). With an explicit scope, let
          // forget() do the resolving and report from its own result.
          const engram = scope ? undefined : await plur.getById(args.id as string)
          if (engram) {
            if (engram.status === 'retired') return { success: false, error: `Already retired: ${args.id}` }
            // force:true — explicit user forget always fully retires, ignoring
            // reference_count. The ref-count decrement path is for internal
            // multi-agent dedup; one plur_forget call = full retirement (#766).
            await plur.forget(args.id as string, undefined, { force: true })
            return { success: true, retired: { id: engram.id, statement: engram.statement } }
          }
          // Not in local store, or an explicit scope was given — let
          // plur.forget() resolve. It routes to remote stores (with prefix
          // stripping per #86 / PR #186), refuses an ambiguous unqualified id
          // (#831), and throws "Engram not found" if it is nowhere.
          await plur.forget(args.id as string, undefined, { force: true, ...(scope ? { scope } : {}) })
          return { success: true, retired: { id: args.id as string, ...(scope ? { scope } : {}) } }
        }
        if (args.search) {
          // remote:false (#776) — forget-by-search resolves local retirement
          // targets; it must not fan the search phrase out to remote hosts.
          const matches = await plur.recall(args.search as string, { limit: 100, remote: false })
          if (matches.length === 0) return { success: false, error: `No active engrams matching "${args.search}"` }
          if (matches.length === 1) {
            await plur.forget(matches[0].id, undefined, { force: true })
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
        const candidates = await plur.ingest(args.content as string, {
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
      description: 'Preview a pack before installing — shows manifest, engram list, security scan, and warnings. Always call this before plur_packs_install to let the user review what they are importing. Accepts a local directory path or an https:// URL pointing to a .tar.gz archive.',
      annotations: { title: 'Preview pack', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Path to the pack directory, or an https:// URL to a .tar.gz pack archive' },
        },
        required: ['source'],
      },
      handler: async (args, plur) => {
        return await plur.previewPack(args.source as string)
      },
    },

    {
      name: 'plur_packs_install',
      description: 'Install an engram pack from a local directory path or an https:// URL pointing to a .tar.gz archive. Runs a mandatory security scan (blocks if secrets found), detects conflicts with existing engrams, and records install metadata in the registry. Call plur_packs_preview first to show the user what the pack contains.',
      annotations: { title: 'Install pack', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Path to the pack directory, or an https:// URL to a .tar.gz pack archive' },
        },
        required: ['source'],
      },
      handler: async (args, plur) => {
        const result = await plur.installPack(args.source as string)
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
            // 'ok' | 'modified' | 'unverified' (#805, F11). `integrity_ok`
            // collapses "cannot be checked" into the same `undefined` an absent
            // field has, so a caller reading only that cannot distinguish a
            // clean pack from one whose baseline was destroyed.
            integrity_status: p.integrity_status,
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
      description: 'Sync engrams via git AND refresh the derived index from YAML. Initializes repo on first call, commits and pushes/pulls on subsequent calls. Provide a remote URL on first call to enable cross-device sync. Pass full=true to drop-and-rebuild the index from YAML (recovery path; YAML stays untouched). Also flushes the remote-write outbox — retries team-scoped writes that were queued while their remote store was unreachable; use plur_outbox to inspect what is queued.',
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
          remote_type: {
            type: 'string',
            enum: ['personal', 'shared'],
            description: 'What the sync remote is for (#640). personal (default): mirror everything non-local, private included — a solo user\'s own backup. shared: push ONLY shared-scope, non-private engrams — personal-family and private engrams never reach the remote, and episode/candidate/tension records derived from non-pushed engrams are stripped too (#686). Persist the choice in config.yaml as sync.remote_type instead of passing it per call.',
          },
        },
      },
      handler: async (args, plur) => {
        const result = await plur.sync(args.remote as string | undefined, {
          full: args.full === true,
          ...(args.remote_type === 'personal' || args.remote_type === 'shared' ? { remoteType: args.remote_type } : {}),
        })

        // #272: block on the background index/reembed chain and surface its
        // failure — the chain's .catch swallows the rejection, so without
        // this a failed index pass reported plain success.
        await plur.waitForIndex()
        const indexError = plur.lastIndexError()

        // Flush outbox after git sync (issue #26)
        let outbox_result: { flushed: number; failed: number; expired_warnings: string[] } | undefined
        let outbox_error: string | undefined
        try {
          outbox_result = await plur.flushOutbox()
        } catch (err) {
          // SURFACED, not swallowed. The `outbox` field below is only added when
          // `outbox_result` is truthy, so a FAILED flush produced a response
          // indistinguishable from one with nothing to flush. The caller here is
          // an agent: it sees success, reports success, and the engrams routed
          // to a remote store stay queued indefinitely. A log line inside
          // `flushOutbox` is not a report to the caller.
          outbox_error = (err as Error).message
        }

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
          ...(outbox_error ? {
            outbox_error,
            outbox_warning:
              `The outbox flush failed — ${outbox_error}. Engrams routed to a remote store are `
              + `still queued locally and were NOT pushed. They retry on the next session_start or plur_sync.`,
          } : {}),
        }
      },
    },

    {
      name: 'plur_outbox',
      description: 'Inspect the remote-write outbox — team-scoped writes queued locally because their remote store was unreachable. Read-only by default; pass flush:true to retry them now. Entries never include the target URL or token.',
      annotations: { title: 'Outbox', readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          flush: { type: 'boolean', description: 'Retry every queued write now, instead of only reporting them. Defaults to false.' },
        },
      },
      handler: async (args, plur) => {
        // Read first, ALWAYS — including on a flush. The entries a flush
        // consumed are the interesting ones ("what was stuck, and for how
        // long"), and after a successful flush they are gone from the store,
        // so reading afterwards would report an empty outbox and tell the
        // caller nothing about what just moved.
        const before = await plur.listOutbox()
        if (args.flush !== true) {
          return { pending: before.length, entries: before }
        }
        const result = await plur.flushOutbox()
        return {
          pending: await plur.outboxCount(),
          flushed: result.flushed,
          failed: result.failed,
          ...(result.expired_warnings.length > 0 ? { expired_warnings: result.expired_warnings } : {}),
          attempted: before,
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
        const sourceEngrams = await plur.list({
          domain: args.domain as string | undefined,
          scope: args.scope as string | undefined,
        })
        // Load existing meta-engrams for deduplication during pipeline
        const existingMetas = (await plur.list()).filter(e => e.id.startsWith('META-'))
        const result = await extractMetaEngrams(sourceEngrams, llm, {
          run_validation: args.run_validation as boolean | undefined,
          existing_metas: existingMetas,
        })

        // Persist unless dry_run
        const isDryRun = args.dry_run === true
        let saveStats: { saved: number; skipped: number } | null = null
        if (!isDryRun && result.results.length > 0) {
          saveStats = await plur.saveMetaEngrams(result.results)
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
        const allEngrams = await plur.list()
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
        const allEngrams = await plur.list()
        const meta = allEngrams.find(e => e.id === (args.meta_engram_id as string))
        if (!meta) {
          throw new Error(`Meta-engram not found: ${args.meta_engram_id}`)
        }

        const testDomain = args.test_domain as string
        const testEngrams = await plur.list({ domain: testDomain })

        const llm = makeHttpLlm(
          args.llm_base_url as string,
          args.llm_api_key as string,
          args.llm_model as string | undefined,
        )

        const result = await validateMetaEngram(meta, testEngrams, testDomain, llm)

        // validateMetaEngram mutates domain_coverage + confidence in-place — persist changes
        await plur.updateEngram(meta)

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
      description: 'Return system health — running version, engram count, episode count, pack count, storage root. Optionally filter engram counts by domain prefix and/or creation date.',
      annotations: { title: 'Status', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Only count engrams whose domain starts with this prefix (e.g. "meridian")' },
          created_after: { type: 'string', description: 'ISO-8601 date (YYYY-MM-DD). Only count engrams learned on or after this date.' },
        },
      },
      handler: async (args, plur) => {
        const status = await plur.status({
          domain: args.domain as string | undefined,
          created_after: args.created_after as string | undefined,
        })
        const versionCheck = getCachedUpdateCheck('@plur-ai/mcp')
        // #761: name the profile + gateway in the other name-stable diagnostic
        // door. status is where agents look when "tools seem missing" — one
        // line here turns a lookup miss into a plur_admin call instead of a
        // false "MCP is down" conclusion. Full inventory: plur_doctor's
        // tool_surface, or plur_admin { action: "help" }.
        const tool_profile = activeToolProfile()
        return {
          version: VERSION,
          tool_profile,
          ...(tool_profile !== 'full' ? {
            tool_surface_note:
              `Tool profile "${tool_profile}": most plur_* operations are not top-level tools — call them ` +
              'as plur_admin { action: "<name>", args: {...} }; send { action: "help" } for the list. ' +
              'A name-lookup miss means a tool moved there, not that the MCP is down.',
          } : {}),
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
          // Artifacts that could not be read (audit 2026-08-03, finding 14).
          // Core reports these; this hand-built response dropped them, so an
          // agent asking for status saw a healthy-looking `pack_count: 0`.
          ...(status.store_errors ? { store_errors: status.store_errors } : {}),
          // Spreading-activation drop counters — absent when both are zero.
          ...(status.spread_drops ? { spread_drops: status.spread_drops } : {}),
          // Version check (issue #151)
          ...(versionCheck?.updateAvailable && versionCheck.latest ? {
            update_available: {
              current: versionCheck.current,
              latest: versionCheck.latest,
              behind: minorVersionsBehind(versionCheck.current, versionCheck.latest),
            },
          } : {}),
          capabilities: await mcpCanary.status(),
        }
      },
    },

    {
      name: 'plur_receipt',
      description:
        'Counted report of what your memory retrieved for you: engrams stored, how many were retrieved and how often, which are most relied on, and how much of the store is dormant. Local and read-only; every figure is directly counted, never estimated. IMPORTANT when relaying to the user: `activation_rate` is COVERAGE over the logging window (≈ how much of the store was surfaced), NOT a quality or effectiveness score — it is naturally low and FALLS as more engrams are added, so never present it as "memory is N% effective". A `summary` line is included; prefer relaying that.',
      annotations: { title: 'Memory receipt', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Restrict to the last N days (integer). Omit for all recorded history.' },
        },
      },
      handler: async (args, plur) => {
        const days = typeof args.days === 'number' && Number.isFinite(args.days) && args.days >= 1
          ? Math.floor(args.days)
          : undefined
        const receipt = await plur.receipt(days ? { days } : undefined)
        return { summary: receiptSummary(receipt), ...receipt }
      },
    },

    {
      name: 'plur_doctor',
      description: 'Diagnose the PLUR ENGINE (embedder, hybrid search, remote-store auth) — not hook/MCP wiring. Reports whether the embedding model loaded, whether hybrid search is fully operational, and — for any configured enterprise/remote store — whether its auth is valid (probes /api/v1/me and decodes token expiry), so a dead or soon-to-expire token surfaces instead of hiding behind a "healthy" report. Run this first when recall feels off or team engrams stop syncing. Does NOT check .cursor/mcp.json, .cursor/hooks.json, or the live MCP tool count — for that, run the `plur doctor` CLI command in a terminal (a different, more thorough check with the same name).',
      annotations: { title: 'Doctor', readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          retry: { type: 'boolean', description: 'If true, reset cached embedder failure state and retry the model load before reporting' },
          rerank_eval: { type: 'boolean', description: 'If true and a reranker is configured (PLUR_RERANKER), run the per-store self-eval gate (#451): probes synthesized from this store\'s own engrams compare rerank-on vs RRF-only ordering. Verdict is cached in the store and advisory — it never auto-disables reranking. Costs one cross-encoder pass per probe (~20 probes).' },
        },
      },
      handler: async (args, plur) => {
        if (args.retry === true) {
          plur.resetEmbedder()
          // #341: also reset reranker caches + failure tracker so a purged
          // corrupt model cache can be re-probed without a process restart.
          plur.resetReranker()
        }
        const status = await plur.status()
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
            // Tier-aware latency framing (#451): the bge quality tier is
            // seconds-scale per recall on CPU (#220); the ms-marco tiny tier
            // is ms-scale — telling tiny-tier users to expect seconds would
            // mask a real fault.
            const latencyNote = rerankerName === 'bge-reranker-v2-m3'
              ? 'seconds-scale per recall on CPU is expected — #220'
              : 'ms-scale per recall on CPU is expected — #451'
            rerankerDetail = rerankerOk
              ? `${rerankerName} loaded and scoring (probe ${Date.now() - probeStart}ms; ${latencyNote})`
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

          // Per-store fit check (#451): run only when the reranker loaded successfully.
          // Cross-encoders can be net-negative out-of-domain — surface the result in
          // doctor so users know whether to keep it enabled.
          if (rerankerOk) {
            try {
              const fitResult = await plur.checkRerankerFit({ rerankerName: rerankerName })
              const sep = fitResult.separability.toFixed(3)
              checks.push({
                check: 'reranker domain fit',
                ok: fitResult.fit,
                detail: fitResult.n_pairs === 0
                  ? 'Not enough engrams to evaluate fit (< 2) — assuming fit'
                  : fitResult.fit
                  ? `Good fit — separability ${sep} on ${fitResult.n_pairs} pairs (threshold ≥ 0.05)`
                  : `Poor fit — separability ${sep} on ${fitResult.n_pairs} pairs (threshold ≥ 0.05). Reranker may be net-negative on this store's domain mix.`,
              })
              if (!fitResult.fit && fitResult.n_pairs > 0) {
                remediation.push(
                  `Reranker "${rerankerName}" shows poor separability (${sep}) on this store's engrams — it may be scoring irrelevant pairs higher than relevant ones. Consider unsetting PLUR_RERANKER or switching to a different tier. The fit check compares same-domain vs cross-domain pair scores; low separability means the model lacks signal on your content.`,
                )
              }
            } catch { /* best-effort — don't let fit check break doctor */ }
          }

          // Per-store eval gate (#451, final task) — ADVISORY. Compares
          // rerank-on vs RRF-only ordering on probes synthesized from this
          // store's own engrams. A 'harmful' verdict fails this check and
          // adds remediation, but never auto-disables reranking — the
          // shipping-default decision stays with a human.
          try {
            let evalStatus: { result: RerankerEvalResult; stale: boolean } | null
            let freshlyRun = false
            if (args.rerank_eval === true) {
              const run = await plur.rerankerSelfEval()
              evalStatus = { result: run.result, stale: false }
              freshlyRun = !run.cached
            } else {
              evalStatus = await plur.rerankerEvalStatus(rerankerName)
            }
            if (!evalStatus) {
              checks.push({
                check: 'reranker per-store eval',
                ok: true,
                detail:
                  'Not yet evaluated on this store — cross-encoders can be net-negative out-of-domain (#451). ' +
                  'Run plur_doctor with rerank_eval:true for the advisory self-check before trusting reranked order.',
              })
            } else {
              const r = evalStatus.result
              const harmful = r.verdict === 'harmful'
              const sign = r.delta_mrr >= 0 ? '+' : ''
              const provenance = freshlyRun ? 'measured now' : `cached ${r.evaluated_at}`
              const staleNote = evalStatus.stale ? ' [STALE — store changed since; re-run with rerank_eval:true]' : ''
              checks.push({
                check: 'reranker per-store eval',
                ok: !harmful,
                detail:
                  `${r.verdict} on this store (${provenance}${staleNote}): ` +
                  `ΔMRR ${sign}${r.delta_mrr.toFixed(3)} vs RRF-only over ${r.scored_probes} probes ` +
                  `(hit@1 ${(r.rrf_hit1 * 100).toFixed(0)}%→${(r.rerank_hit1 * 100).toFixed(0)}%, ` +
                  `${r.promotions} promoted / ${r.demotions} demoted, ~${r.mean_rerank_ms.toFixed(0)}ms/probe)`,
              })
              if (harmful) {
                remediation.push(
                  `Per-store self-eval measured reranker "${rerankerName}" as net-negative on THIS store ` +
                  `(ΔMRR ${r.delta_mrr.toFixed(3)}; it demoted known-relevant engrams in ${r.demotions}/${r.scored_probes} probes). ` +
                  `This gate is advisory — reranking remains enabled. Unset PLUR_RERANKER to opt out for this store, ` +
                  `or re-run plur_doctor with rerank_eval:true after the store grows/changes.`,
                )
              }
            }
          } catch (err) {
            checks.push({
              check: 'reranker per-store eval',
              ok: false,
              detail: `self-eval failed: ${(err as Error).message}`,
            })
          }
        }
        const canaryStatuses = await mcpCanary.status()
        for (const cs of canaryStatuses) {
          if (!cs.healthy) {
            checks.push({ check: `capability: ${cs.capability}`, ok: false, detail: cs.warning })
            if (cs.warning) remediation.push(cs.warning)
          }
        }
        // Remote store auth/reachability (#295) — without this, doctor reports
        // "healthy" while the enterprise token is expired and writes silently
        // queue. Probe /me per configured remote and decode token expiry.
        // Hosts a FRESH /me probe just reached, so the recall-status block
        // below can defer to live evidence instead of contradicting it (#864).
        const probedOkHosts = new Set<string>()
        try {
          const remotes = await plur.checkRemoteHealth({ timeoutMs: 5000 })
          for (const h of remotes) {
            if (h.status === 'ok') probedOkHosts.add(normalizeEndpointUrl(h.url))
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
        // #776 A4′: live-recall leg status per host, fed by the last recall
        // outcomes (not by a fresh probe) — this is what tells the user WHY
        // recent recalls served local-only, including states /me can't see
        // (rate_limited, unsupported, circuit-breaker cooldown, silent scope
        // narrowing via dropped_scopes).
        try {
          for (const s of plur.remoteStoreStatus()) {
            const dropped = s.dropped_scopes?.length ? ` (dropped scopes: ${s.dropped_scopes.join(', ')})` : ''
            const failed = s.status !== 'ok' || (s.dropped_scopes?.length ?? 0) > 0
            // An observation describes the moment it was taken. Past the TTL,
            // or once a fresh /me probe has reached the host, it is history —
            // report it as history rather than as a live fault, and do not
            // hand the operator remediation for a problem that may be over
            // (#864). Both facts are stated so nothing is silently dropped.
            const stale = (s.age_ms ?? 0) > REMOTE_STATUS_TTL_MS
            // Same rule the invalidation path uses: a successful /me probe
            // contradicts a network-class failure only. An authorization or
            // endpoint-support failure is not disproved by a different route
            // succeeding, and downgrading it here would hide a live problem
            // behind a green check.
            const contradicted = probedOkHosts.has(s.host) && PROBE_CLEARABLE_STATES.has(s.status)
            const historical = failed && (stale || contradicted)
            if (historical) {
              const why = contradicted
                ? 'the /me probe above just reached this host, so this is not the current state'
                : 'older than the status TTL, so this is not the current state'
              checks.push({
                check: `remote recall: ${s.host}`,
                ok: true,
                detail: `Last live recall: ${s.status}${dropped} ${formatAge(s.age_ms)} — ${why}. Recalls at that time served local results only.`,
              })
              continue
            }
            checks.push({
              check: `remote recall: ${s.host}`,
              ok: !failed,
              detail: failed
                ? `Last live recall: ${s.status}${dropped} ${formatAge(s.age_ms)} — recent recalls served local results only.`
                : `Last live recall ok (${s.count} row(s) in ${s.ms}ms) ${formatAge(s.age_ms)}`,
            })
            const fix = doctorRemoteRemediation(s)
            if (fix) remediation.push(fix)
          }
          // (url, token) fan-out sanity: differing tokens per endpoint mean
          // one POST per token on every recall — a misconfiguration.
          for (const c of plur.remoteEndpointTokenConflicts()) {
            checks.push({
              check: `remote store tokens: ${c.url}`,
              ok: false,
              detail: `${c.tokens} distinct tokens configured for this endpoint — recall dials once per (url, token).`,
            })
            remediation.push(`Remote ${c.url}: ${c.tokens} distinct tokens are configured across its store entries — consolidate to one token in ~/.plur/config.yaml so recall dials the host once.`)
          }
        } catch { /* best-effort — never let recall status break doctor */ }
        // #761: report the SURFACE alongside the health. An agent that cannot
        // find `plur_recall_hybrid` by name needs to learn it moved under
        // plur_admin — and doctor is the one door that is name-stable across
        // profiles, so it is where that answer belongs. Without this, doctor
        // can report green while the caller concludes the MCP is gone.
        const tool_surface = describeToolSurface()
        return {
          ok: checks.every(c => c.ok),
          checks,
          embedder: {
            before_probe: before,
            after_probe: after,
          },
          capabilities: canaryStatuses,
          tool_surface,
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

        // Initialize session telemetry — tracks per-pack injection counts for
        // activation-rate validation (target: 25-80 sessions/month per user).
        // TTL cleanup runs here to evict any unclosed sessions from prior starts.
        _cleanExpiredSessions(plur)
        _sessionTelemetry.set(session_id, {
          pack_counts: {},
          injection_calls: 0,
          started_at: new Date().toISOString(),
        })

        // Auto-discovery happens in Plur constructor — no manual call needed.

        // Flush outbox — retry pending remote writes (issue #26)
        let outbox_result: { flushed: number; failed: number; expired_warnings: string[] } | undefined
        let outbox_error: string | undefined
        try {
          outbox_result = await plur.flushOutbox()
        } catch (err) {
          // SURFACED, not swallowed. The `outbox` field below is only added when
          // `outbox_result` is truthy, so a FAILED flush produced a response
          // indistinguishable from one with nothing to flush. The caller here is
          // an agent: it sees success, reports success, and the engrams routed
          // to a remote store stay queued indefinitely. A log line inside
          // `flushOutbox` is not a report to the caller.
          outbox_error = (err as Error).message
        }

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
        // #243: ALSO register the default under this session's own key, so a
        // caller that threads session_id through plur_learn / plur_recall /
        // plur_session_scope keeps its scope even when another session starts
        // later and resets the process slot above (ADR-0004 per-session
        // isolation). Cleared at plur_session_end / TTL eviction.
        plur.setSessionScope(default_scope, { session: session_id })
        {
          // Record the start default + its provenance in the session-keyed
          // telemetry record: plur_session_scope op:"clear" reverts to it and
          // op:"show" reports how the effective scope was derived.
          const t = _sessionTelemetry.get(session_id)
          if (t) {
            t.default_scope = default_scope
            t.default_scope_source = scope_source as 'caller' | 'project-config' | 'none'
          }
        }

        // Get store stats for context.
        //
        // Belt and braces (audit 2026-08-03, finding 6). `status()` now reports
        // unreadable artifacts instead of throwing, but starting a session is
        // not worth failing over STATISTICS under any circumstance: this is a
        // decorative field, and a throw here used to mean no session could start
        // at all. Whatever went wrong is surfaced through `store_errors` below
        // rather than by refusing to start.
        const status = await plur.status().catch(() => null)
        const store_stats = {
          engram_count: status?.engram_count ?? 0,
          episode_count: status?.episode_count ?? 0,
          pack_count: status?.pack_count ?? 0,
        }
        // Surface a broken artifact where the operator will actually see it —
        // the session opener — rather than only in `plur status`.
        const store_errors = status?.store_errors

        // Warm remote store caches before injection (#235)
        // Ensures enterprise engrams are available for the first injectHybrid call.
        await plur.warmRemoteCaches().catch(() => {})

        // Inject relevant engrams
        let engrams: { text: string; count: number; injected_ids: string[] } | null = null
        try {
          const result = await plur.injectHybrid(task, {
            scope: tags?.length ? `tags:${tags.join(',')}` : undefined,
            session_id, // stamped on the co_injection provenance event (#452)
            source: 'session_start',
            remote_timeout_ms: 5000, // session_start warm budget (#776)
          })
          _recordInjectionTelemetry(session_id, result.injected_packs)
          if (result.count > 0) {
            const lines: string[] = []
            if (result.directives) lines.push('## DIRECTIVES\n', result.directives)
            if (result.constraints) lines.push('\n## CONSTRAINTS\n', result.constraints)
            if (result.consider) lines.push('\n## ALSO CONSIDER\n', result.consider)
            engrams = { text: lines.join('\n'), count: result.count, injected_ids: result.injected_ids }
          }
        } catch {
          // Fall back to BM25 if hybrid unavailable
          const result = await plur.inject(task, {
            scope: tags?.length ? `tags:${tags.join(',')}` : undefined,
            session_id,
            source: 'session_start',
          })
          _recordInjectionTelemetry(session_id, result.injected_packs)
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
            version_warning = `CRITICAL: Running PLUR v${versionCheck.current} — latest is v${versionCheck.latest} (${behind} minor versions behind). Known bugs may be present. Update immediately: upgrade @plur-ai/cli and re-run plur init (configs pin versions; running @latest no longer updates them)`
            guide = `⚠️ ${version_warning}\n\n${guide}`
          } else {
            version_warning = `Update available: PLUR v${versionCheck.current} → v${versionCheck.latest}. Run: npm i -g @plur-ai/cli@latest && plur init (configs pin versions)`
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
          // Wording matches post-#674 behavior (scope-audit 2026-07-24): with
          // synced covers, a genuinely-unscoped write can AUTO-ROUTE to a
          // covers-matching team scope — it is no longer always tagged "global".
          guide += `\n\n⚠️ No project scope detected. plur_learn calls without explicit scope may AUTO-ROUTE to a ` +
            `registered team scope whose covers confidently match the engram's domain/tags (the response reports ` +
            `\`routed\` when that happens); otherwise they land at the unscoped default "global" and will appear in ` +
            `EVERY project's future sessions. Create a .plur.yaml NOW to prevent this: ` +
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
            // Wording matches post-#674 behavior (scope-audit 2026-07-24):
            // unscoped writes are no longer guaranteed to land at "global" —
            // covers-matching ones auto-route to the shared team store.
            : `\n\nRemote store scopes available: ${scopeList}. Set scope PER ENGRAM by content: when an engram is ` +
              `relevant to the team (engineering patterns, architecture decisions, project conventions), set scope to ` +
              `the matching remote scope in plur_learn. Personal preferences, local project details, and corrections ` +
              `specific to your workflow can be left unscoped — but note an unscoped write whose domain/tags ` +
              `confidently match a team scope's covers AUTO-ROUTES to that shared team store (the response reports ` +
              `\`routed\` when that happens); otherwise it lands at the unscoped default, "global" — the ` +
              `cross-project personal namespace. Do NOT rely on auto-routing for TEAM knowledge — set the matching ` +
              `scope explicitly; a weak or absent covers match falls back to "global" and never reaches the shared store.`

          // Surface authorized-but-unregistered scopes (#292). Best-effort:
          // gated to enterprise users (remote stores configured), bounded by a
          // short timeout, and fully swallowed on error — never blocks or fails
          // session_start. Only hints when there's actually something to add.
          try {
            const discoveries = await plur.discoverRemoteScopes({ timeoutMs: 3000 })
            // Persist covers/description/sensitivity so suggestScope activates (#668).
            plur.persistScopeMetadata(discoveries)
            // #295: surface auth/reachability failures LOUDLY. discoverRemoteScopes
            // already probed /me per URL — a failure here means team-scoped writes
            // are silently queuing to the outbox. Don't swallow it.
            const failures = discoveries.filter(d => !d.ok)
            if (failures.length > 0) {
              const authExpired = failures.some(f => /\b40[13]\b/.test(f.error ?? ''))
              // The count is what is QUEUED, not what this flush failed on
              // (#667). `outbox_result.failed` counts only entries this flush
              // attempted and lost — so when the host is in breaker cooldown
              // the flush attempts nothing, `failed` is 0, and the warning
              // said nothing at all while N team writes sat queued. The
              // pending total is the number the user needs to act on.
              const pending = await plur.outboxCount().catch(() => outbox_result?.failed ?? 0)
              const urls = [...new Set(failures.map(f => f.url))].join(', ')
              guide += authExpired
                ? `\n\n⚠️ ENTERPRISE STORE AUTH FAILED (token expired/invalid): ${urls}. ` +
                  `Team-scoped engrams are NOT syncing` + (pending > 0 ? ` — ${pending} queued in the outbox` : '') +
                  `. Reauth: open <host>/auth/github (or <host>/me/api-keys) in a browser, paste the token into ` +
                  `~/.plur/config.yaml, then restart Claude/MCP. Queued engrams flush on the next session_start.`
                : `\n\n⚠️ ENTERPRISE STORE UNREACHABLE: ${urls}. ` +
                  `Reads fall back to local; team-scoped writes queue in the outbox` +
                  (pending > 0 ? ` (${pending} pending — inspect with plur_outbox, retry with plur_outbox {flush:true})` : '') +
                  ` until it recovers. Check connectivity/VPN.`
            }
            // #647: a QUIET, per-scope-aware hint. `d.unregistered` already
            // excludes dismissed scopes; also drop personal-family (they can't be
            // registered from discovery). Point at the user-facing `plur scopes`
            // CLI for the actual register/dismiss decision instead of the old
            // all-or-nothing `register:true`.
            const offerable = [...new Set(discoveries.filter(d => d.ok).flatMap(d => d.unregistered))].filter(isSharedScope)
            if (offerable.length > 0) {
              guide += `\n\n🔎 ${offerable.length} authorized scope(s) not yet registered. Tell the user they can run ` +
                `\`plur scopes\` to register or dismiss them per-scope (dismissed scopes stop being offered; ` +
                `\`plur scopes --reoffer\` re-surfaces them).`
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

        // #761: the lean surface is invisible in tools/list, and session_start
        // is the first tool an agent calls — one line here tells it the
        // gateway exists BEFORE it ever misses a name and concludes the MCP
        // is down. Silent under 'full', where nothing is hidden.
        const session_tool_profile = activeToolProfile()
        if (session_tool_profile !== 'full') {
          guide += `\n\nTool profile "${session_tool_profile}": most plur_* tools are not exposed by name — ` +
            'call them via plur_admin { action: "<tool name>", args: {...} } ' +
            '(send { action: "help" } for the full action list).'
        }

        const sessionResponse: Record<string, unknown> = {
          session_id,
          engrams: engrams ?? [],
          store_stats,
          ...(store_errors ? { store_errors } : {}),
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
          ...(outbox_error ? {
            outbox_error,
            outbox_warning:
              `The outbox flush failed — ${outbox_error}. Engrams routed to a remote store are `
              + `still queued locally and were NOT pushed. They retry on the next session_start or plur_sync.`,
          } : {}),
          // Version staleness warning (issue #151)
          ...(version_warning ? { version_warning, version: VERSION } : {}),
        }
        // A4′ (#776): per-host remote recall degradation from the injection
        // above — attached only when a host is non-ok or scope-narrowed.
        attachRemoteStoreDegradation(sessionResponse, plur)
        return sessionResponse
      },
    },

    {
      name: 'plur_session_scope',
      description:
        'Adjust or inspect the session default write scope MID-session — narrow, expand, or switch context without ' +
        'restarting the session (#243). op:"set" replaces the default scope used by unscoped plur_learn calls for the ' +
        'rest of the session AND the org context that decides which enterprise hosts plur_recall dials; op:"show" ' +
        'reports the effective scope and how it was derived (project config, session_start default, or a mid-session ' +
        'set); op:"clear" reverts to the scope the session started with. Use when the conversation genuinely pivots — ' +
        'a focused bug fix surfacing a team-wide architecture insight, or switching to another org\'s project. Do NOT ' +
        'oscillate scope call-by-call: for a one-off write to a different scope, pass scope explicitly on that ' +
        'plur_learn instead (explicit per-call scope always beats the session default). Every change is logged as a ' +
        'session_scope_changed history event.',
      annotations: { title: 'Session scope', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['set', 'show', 'clear'],
            description: 'set: replace the session default write scope; show: report the effective scope and its derivation; clear: revert to the session-start default.',
          },
          scope: {
            type: 'string',
            description: 'New session default scope (op:"set" only), e.g. "project:myapp" or "group:org/team". Must match a configured store scope to route writes to a remote store — other strings stay local under that namespace.',
          },
          reason: {
            type: 'string',
            description: 'Optional one-line explanation of why the scope is changing — logged on the session_scope_changed event for retrospective debugging.',
          },
          session_id: {
            type: 'string',
            description: 'Session to target (from plur_session_start). Optional when one session is open; REQUIRED when several are — a scope change must never decide another session\'s writes.',
          },
        },
        required: ['op'],
      },
      handler: async (args, plur) => {
        const op = args.op as string
        if (op !== 'set' && op !== 'show' && op !== 'clear') {
          throw new Error(`plur_session_scope: op must be "set", "show" or "clear", got ${JSON.stringify(args.op)}`)
        }
        const reason = args.reason as string | undefined
        const { session, ambiguous, open } = _resolveScopeSession(args)
        const record = session ? _sessionTelemetry.get(session) : undefined
        const remote_scopes = plur.getWritableRemoteScopes()
        const withCommon = (body: Record<string, unknown>): Record<string, unknown> => ({
          op,
          ...body,
          ...(session ? { session_id: session } : {}),
          ...(remote_scopes.length > 0 ? { remote_scopes } : {}),
        })

        if (op === 'show') {
          const scope = plur.getSessionScope({ session })
          const source = record
            ? (record.scope_adjusted
                ? 'session-adjusted'
                : record.default_scope_source === 'caller'
                  ? 'session-start'
                  : record.default_scope_source ?? 'none')
            : scope == null ? 'none' : 'process-default'
          return withCommon({
            scope,
            source,
            ...(ambiguous ? {
              warning: `${open} sessions are open — this is the process-default slot, not a specific session's scope. Pass session_id (from plur_session_start) to inspect one.`,
            } : {}),
            guide: scope == null
              ? 'No session default scope is set: unscoped plur_learn writes auto-route on a confident covers match or land at the unscoped default. Explicit per-call scope always wins.'
              : `Unscoped plur_learn calls this session default to "${scope}"; recall dialing follows the same org context. Explicit per-call scope always wins.`,
          })
        }

        // Writes (set/clear) refuse ambiguity — landing in the process slot
        // would let this session's change decide another session's writes.
        if (ambiguous) {
          throw new Error(
            `plur_session_scope: ${open} sessions are open on this server — pass session_id (from plur_session_start) ` +
            `so the scope change targets the right session and cannot bleed into another one.`,
          )
        }

        if (op === 'set') {
          const scope = args.scope
          if (typeof scope !== 'string' || scope.trim().length === 0) {
            throw new Error('plur_session_scope: op:"set" requires a non-empty string "scope" (use op:"clear" to revert to the session-start default)')
          }
          if (!/^\S+$/.test(scope) || scope.length > 200) {
            throw new Error(`plur_session_scope: invalid scope ${JSON.stringify(scope)} — a scope is a single token without whitespace (e.g. "project:myapp", "group:org/team"), max 200 chars`)
          }
          const { previous, next } = plur.adjustSessionScope(scope, { session, reason, trigger: 'set' })
          if (record) record.scope_adjusted = true
          // Guard (#243): a shared/team default means every unscoped write for
          // the rest of the session carries team-visible scope — say so at the
          // moment it becomes true, not per-write. The per-write secrets/
          // sensitivity guard is unchanged and still scans every learn.
          const remoteEntry = remote_scopes.find(s => s.scope === scope)
          const warning = isSharedScope(scope)
            ? (remoteEntry
                ? `"${scope}" routes to the shared remote store at ${remoteEntry.url}: every unscoped plur_learn for the rest of this session defaults there, visible to everyone with read access to that scope. The per-write secrets/sensitivity guard still scans each write (offending content is demoted to local), but relevance is your call — clear or narrow the scope when the conversation leaves team context.`
                : `"${scope}" is a shared-family scope but matches no configured remote store scope, so writes stay on this machine under that namespace. The write-time sensitivity guard treats it as shared (scans + demotes offending content). If you expected a team store, check the remote_scopes list.`)
            : undefined
          return withCommon({
            previous_scope: previous,
            new_scope: next,
            ...(reason ? { reason } : {}),
            ...(warning ? { warning } : {}),
          })
        }

        // op === 'clear' — revert to the session-start default. With a live
        // session record that is the recorded default (robust even if another
        // session_start reset the process slot since); otherwise fall back to
        // the project config, the same source session_start derives from.
        const restored = record !== undefined
          ? (record.default_scope ?? null)
          : (readProjectConfig().scope ?? null)
        const restored_source = record !== undefined
          ? (record.default_scope_source === 'caller' ? 'session-start' : record.default_scope_source ?? 'none')
          : (restored != null ? 'project-config' : 'none')
        const { previous, next } = plur.adjustSessionScope(restored, { session, reason, trigger: 'clear' })
        if (record) record.scope_adjusted = false
        return withCommon({
          previous_scope: previous,
          new_scope: next,
          restored_source,
          ...(reason ? { reason } : {}),
        })
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
            await plur.learn(statement, { type: type as any })
            engrams_created++
          }
        }

        // Capture episode
        const episode = plur.capture(summary, {
          session_id,
          channel: 'mcp',
        })

        // Collect injection telemetry before cleanup
        const telemetry = session_id ? _sessionTelemetry.get(session_id) : undefined
        const injection_summary = telemetry && telemetry.injection_calls > 0
          ? {
              pack_counts: { ...telemetry.pack_counts },
              total_injections: telemetry.injection_calls,
              session_duration_ms: Date.now() - new Date(telemetry.started_at).getTime(),
            }
          : undefined

        // Clean up session telemetry
        if (session_id) {
          _sessionTelemetry.delete(session_id)
          // #243: drop this session's keyed scope registration too — a
          // long-lived server would otherwise retain one registry entry per
          // session it has ever served (see SessionScopeRegistry.clear).
          plur.clearSessionScope({ session: session_id })
        }

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

        const status = await plur.status()

        // Emit a checkpoint event (#1052) — best-effort, never fails the session.
        // Hashes the store at session-end time; the checkpoint chains onto the
        // last history event written during this session (engrams learned above).
        let checkpoint_hash: string | undefined
        try {
          const plurRoot = plur.storageRoot
          const engramsPath = join(plurRoot, 'engrams.yaml')
          const cp = emitCheckpoint(plurRoot, engramsPath, 'session_end')
          // The checkpoint's own hash, not the store's. Returning store_hash
          // under this name told callers to anchor the wrong digest.
          checkpoint_hash = cp.event_hash ?? undefined
        } catch { /* checkpoint is best-effort */ }

        return {
          engrams_created,
          episode_id: episode.id,
          total_engrams: status.engram_count,
          ...(checkpoint_hash !== undefined ? { checkpoint_hash } : {}),
          ...(injection_summary ? { injection_summary } : {}),
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
          // Filesystem stores are read sources — plur_learn writes to the
          // primary engrams.yaml and carries the scope label there (#766).
          // Pre-populate the file via plur_packs_export or direct YAML edit
          // to inject team engrams; plur_learn with this scope will land them
          // in your primary store tagged with the scope.
          ...(path && !scopeDropped && !url ? {
            note: `Store initialized at ${path}. plur_learn calls with scope "${result.scope}" are tagged with that scope but stored in your primary engrams.yaml. To share engrams across machines via this file, populate it via plur_packs_export or direct YAML and commit it to your repo.`,
          } : {}),
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
        const outboxCount = await plur.outboxCount()
        return {
          stores,
          count: stores.length,
          ...(outboxCount > 0 ? { outbox_pending: outboxCount } : {}),
        }
      },
    },

    {
      name: 'plur_suggest_scope',
      description: 'Suggest which registered scope(s) an engram belongs in, ranked by fit. Deterministic — no LLM, no network. Scores the statement keywords, optional domain (a dotted namespace like "plur.core.security"), and tags against the covers[] each scope declares. ADVISORY ONLY: this does not route or store anything; pass the chosen scope to plur_learn yourself. Returns candidates sorted by confidence (empty when nothing matches). Candidates below min_confidence (default: scope_routing.min_confidence config, else 0.15) are suppressed — a lone coincidental keyword scores ≈0.12 and is noise, not signal (#670); pass min_confidence: 0 to see every scored candidate.',
      annotations: { title: 'Suggest scope', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The engram statement to route' },
          domain:    { type: 'string', description: 'Optional dotted namespace for the engram (e.g. "plur.core.security") — strongest routing signal' },
          tags:      { type: 'array', items: { type: 'string' }, description: 'Optional tags on the engram' },
          min_confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Suppress candidates below this confidence (0-1; out-of-range values are clamped). Default: scope_routing.min_confidence from config, else 0.15 — clips lone-keyword noise (≈0.12) while keeping real multi-signal matches. Pass 0 for the unfiltered list.' },
        },
        required: ['statement'],
      },
      handler: async (args, plur) => {
        // #670 keyword floor, precedence: explicit tool arg > the user's
        // scope_routing.min_confidence config > SUGGEST_DISPLAY_MIN_CONFIDENCE
        // (0.15 — the display default; a suggestion surface that shows
        // 0.12-confidence lone-keyword hits teaches agents to distrust it).
        // An explicit arg of 0 wins (unfiltered). The arg is clamped to [0,1]
        // and non-finite values (NaN/Infinity) fall through to the defaults:
        // the JSON-schema bounds are advisory only — the arg validator maps
        // `type: number` to a bare z.number(), so bounds must be enforced here.
        const raw = args.min_confidence
        const explicit = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(1, Math.max(0, raw))
          : undefined
        const minConfidence = explicit
          ?? plur.getScopeRoutingConfig().min_confidence
          ?? SUGGEST_DISPLAY_MIN_CONFIDENCE
        const candidates = await plur.suggestScope({
          statement: args.statement as string,
          domain: args.domain as string | undefined,
          tags: args.tags as string[] | undefined,
        }, { minConfidence })
        return { candidates, count: candidates.length, min_confidence: minConfidence }
      },
    },

    {
      name: 'plur_scopes_discover',
      description: 'Discover which scopes your remote token is authorized for via the enterprise server (GET /api/v1/me), and which of those are not yet registered locally. Read-only by default; pass register:true to register all authorized-but-unregistered scopes in one step. Only shared-family scopes (group:/project:/space:/team:/org:/public) are auto-registered — personal-family scopes (global/local/user:*/agent:*) advertised by /me are skipped and surfaced in the result, and scopes the user has dismissed are respected (NOT registered by the batch path; register one individually via the CLI `plur scopes register <scope>` to override, which also clears the dismissal). Use this when you have access to multiple team scopes on one server.',
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
        // #345 D2: surface the server-authoritative description/covers per scope
        // so an agent can pick the right scope from discovery alone (instead of
        // guessing from the bare scope name). Each authorized scope is annotated
        // with its metadata when the server returned any; `registered` flags
        // whether it's already in local config.
        const enrich = (d: typeof discoveries[number]) => {
          if (!d.ok) return d
          const byScope = new Map(d.metadata.map(m => [m.scope, m]))
          const registeredSet = new Set(d.registered)
          const scopes = d.authorized.map(scope => {
            const m = byScope.get(scope)
            return {
              scope,
              registered: registeredSet.has(scope),
              ...(m?.description ? { description: m.description } : {}),
              ...(m && m.covers.length ? { covers: m.covers } : {}),
            }
          })
          return { ...d, scopes }
        }
        const discovered = discoveries.map(enrich)
        if (!register) {
          return { discovered }
        }
        const registered = await plur.registerDiscoveredScopes({ url })
        return { discovered, registered }
      },
    },

    {
      name: 'plur_promote',
      description: 'Activate candidate engrams so they appear in injection results. Status change only — it does NOT move an engram to another scope; to promote an engram into a team/shared scope use plur_rescope (#676).',
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
          const engram = await plur.getById(id)
          if (!engram) { errors.push({ id, error: 'Not found' }); continue }
          if (engram.status === 'active') { errors.push({ id, error: 'Already active' }); continue }
          if (engram.status === 'retired') { errors.push({ id, error: 'Cannot promote retired' }); continue }

          engram.status = 'active'
          engram.activation.retrieval_strength = 0.7
          engram.activation.storage_strength = 1.0
          engram.activation.last_accessed = new Date().toISOString().split('T')[0]
          // updateEngram returns whether a row was actually written. Ignoring
          // it reported a promotion that never happened — for an engram that
          // vanished, changed concurrently, or lives in a read-only store
          // (#813, audit finding 17).
          const written = await plur.updateEngram(engram)
          if (!written) {
            errors.push({ id, error: 'Not persisted — the engram may have been removed or its store is read-only' })
            continue
          }
          promoted.push({ id, statement: engram.statement })
        }

        return { promoted, errors, success: errors.length === 0 }
      },
    },

    {
      name: 'plur_rescope',
      description: 'Move existing engram(s) to a different scope (#676) — e.g. promote a personal/local engram into a team scope so it reaches the shared store. Bypasses the content-hash dedup that makes a plur_learn re-emit a silent no-op: rescope matches by id and moves the engram. Remote targets (a configured writable store scope): a copy is pushed via the routed write path (the server assigns the id, provenance is kept in the copy\'s source field) and the local original is soft-retired with a superseded_by link — set keep_local:true to keep it active. Local targets (local, global, project:*): the scope is rewritten in place, preserving id and activation. The target must be local/global/project:* or a scope with a configured writable store — anything else fails early (typo protection). Content is re-scanned for secrets/sensitive material before any shared/remote target and a hit blocks the move. Batch via ids; dry_run:true previews every decision without mutating anything. NOT candidate activation — that is plur_promote.',
      annotations: { title: 'Rescope', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Single engram ID to move' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Multiple engram IDs to move to the same target scope (batch)' },
          target_scope: { type: 'string', description: 'Destination scope: local, global, project:<name>, or a scope with a configured writable store (e.g. group:org/team)' },
          keep_local: { type: 'boolean', description: 'Remote targets only: keep the local original active after the push (default false — it is retired with a superseded_by link so it stops injecting)' },
          dry_run: { type: 'boolean', description: 'Preview the per-engram outcome without mutating anything, local or remote' },
        },
        required: ['target_scope'],
      },
      handler: async (args, plur) => {
        const targetIds = (args.ids as string[] | undefined) ?? (args.id ? [args.id as string] : [])
        if (targetIds.length === 0) throw new Error('Provide id or ids')
        const { results, success } = await plur.rescope(targetIds, args.target_scope as string, {
          keep_local: args.keep_local as boolean | undefined,
          dry_run: args.dry_run as boolean | undefined,
        })
        return {
          results,
          success,
          ...(args.dry_run === true ? { dry_run: true, note: 'Dry run — nothing was changed.' } : {}),
        }
      },
    },

    {
      name: 'plur_tensions',
      description: 'Tension lifecycle (#181). Default: list persisted tension records (unresolved first). scan:true runs an LLM contradiction scan, persists NEW detections as records, and skips already-recorded pairs. Lifecycle actions: action:"confirm" (real conflict), action:"dismiss" (false positive — pair suppressed from future scans), action:"resolve" + winner:<engram_id> (loser engram retired). Scan requires OPENAI_API_KEY or OPENROUTER_API_KEY env var, or explicit llm_base_url + llm_api_key args.',
      annotations: { title: 'Tensions', readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Filter by scope' },
          domain: { type: 'string', description: 'Filter by domain prefix' },
          scan: { type: 'boolean', description: 'Run an active contradiction scan using an LLM judge. New detections are persisted as tension records; recorded pairs (any status) are skipped. Requires OPENAI_API_KEY or OPENROUTER_API_KEY env var, or explicit llm_base_url + llm_api_key args.' },
          persist: { type: 'boolean', description: 'Persist scan detections as tension records (default true). Set false for a dry-run scan that also ignores the recorded-pair suppress list.' },
          action: { type: 'string', enum: ['confirm', 'dismiss', 'resolve'], description: 'Lifecycle action on a persisted tension record (requires id). confirm: mark real. dismiss: false positive, suppress the pair. resolve: pick winner (requires winner), the losing engram is retired.' },
          id: { type: 'string', description: 'Tension record id (T-YYYY-MMDD-NNN) for action mode' },
          winner: { type: 'string', description: 'Engram id that wins the tension (action:"resolve" only). The other engram is retired.' },
          status: { type: 'string', enum: ['detected', 'confirmed', 'dismissed', 'resolved', 'all'], description: 'List-mode status filter. Default: unresolved records (detected + confirmed).' },
          llm_base_url: { type: 'string', description: 'OpenAI-compatible API base URL for scan mode (e.g. https://api.openai.com/v1)' },
          llm_api_key: { type: 'string', description: 'API key for the LLM (scan mode)' },
          llm_model: { type: 'string', description: 'Model name for scan mode (default: gpt-4o-mini)' },
          min_confidence: { type: 'number', description: 'Minimum confidence threshold for scan mode (0–1, default: 0.7)' },
          max_pairs: { type: 'number', description: 'Maximum candidate pairs to evaluate in scan mode (default: 50)' },
          batch_size: { type: 'number', description: 'Pairs judged per LLM call in scan mode (default: 5). Set to 1 for sequential single-pair judging.' },
          temporal_discount: { type: 'boolean', description: 'Multiply judge confidence by a days-apart ladder (same day x1.0 ... 15+ days x0.3) in scan mode (#240). Overrides the config default (tensions.temporal_discount, off by default). The judge prompt already carries recorded dates; enable this only when date-aware judging alone leaves too many temporal-evolution false positives.' },
        },
      },
      handler: async (args, plur) => {
        // --- Lifecycle actions (#181) ---
        if (args.action) {
          const id = args.id as string | undefined
          if (!id) throw new Error(`action:"${args.action}" requires id (tension record id, e.g. T-2026-0703-001)`)
          if (args.action === 'confirm') {
            const record = plur.confirmTension(id)
            return { record, message: `Tension ${id} confirmed as a real conflict. Resolve it with action:"resolve" + winner:<engram_id>.` }
          }
          if (args.action === 'dismiss') {
            const record = plur.dismissTension(id)
            return { record, message: `Tension ${id} dismissed — the pair is suppressed from future scans.` }
          }
          if (args.action === 'resolve') {
            const winner = args.winner as string | undefined
            if (!winner) throw new Error('action:"resolve" requires winner (the engram id to keep)')
            const { record, retired_id } = await plur.resolveTension(id, winner)
            return { record, retired: retired_id, message: `Tension ${id} resolved: ${winner} wins, ${retired_id} retired.` }
          }
          throw new Error(`Unknown action: ${args.action}. Use confirm, dismiss, or resolve.`)
        }

        const engrams = await plur.list({
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

          // #240: config supplies the temporal defaults (tensions: block in
          // config.yaml); an explicit temporal_discount arg overrides.
          const tensionsConfig = plur.getTensionsConfig()
          // #181: recorded pairs (any status) are excluded — dismissals are
          // suppressed, prior detections are not re-judged. persist:false is
          // a dry run: no records written AND no suppress-list applied.
          const persist = args.persist !== false
          const result = await scanForTensions(engrams, llm, {
            min_confidence: args.min_confidence as number | undefined,
            max_pairs: args.max_pairs as number | undefined,
            batch_size: args.batch_size as number | undefined,
            temporal_domains: tensionsConfig.temporal_domains,
            snapshot_pairs: tensionsConfig.snapshot_pairs,
            temporal_discount: (args.temporal_discount as boolean | undefined) ?? tensionsConfig.temporal_discount,
            ...(persist ? { exclude_pairs: new Set(plur.suppressedTensionPairKeys()) } : {}),
          })
          const persisted = persist && result.tensions.length > 0
            ? await plur.recordTensions(result.tensions)
            : undefined

          return {
            pairs_checked: result.pairs_checked,
            count: result.new_tensions,
            ...(persisted ? { persisted_new: persisted.new_count } : {}),
            tensions: result.tensions.map((t, i) => ({
              ...(persisted ? { tension_id: persisted.records[i].id, category: persisted.records[i].category, status: persisted.records[i].status } : {}),
              engram_a: { id: t.id_a, statement: t.statement_a },
              engram_b: { id: t.id_b, statement: t.statement_b },
              confidence: t.confidence,
              reason: t.reason,
              ...(t.days_apart !== undefined ? { days_apart: t.days_apart } : {}),
              ...(t.raw_confidence !== undefined ? { raw_confidence: t.raw_confidence } : {}),
            })),
            ...(persisted && persisted.new_count > 0
              ? { next_steps: 'Review each tension: action:"confirm" (real), action:"dismiss" (false positive), or action:"resolve" + winner:<engram_id> (retire the loser).' }
              : {}),
          }
        }

        // --- List mode (#181): persisted tension records ---
        const statusArg = args.status as TensionStatus | 'all' | undefined
        const records = statusArg === 'all'
          ? plur.listTensions()
          : plur.listTensions({ status: statusArg ? [statusArg] : ['detected', 'confirmed'] })

        // Legacy relations.conflicts pairs (unvalidated importer heuristics or
        // pre-#138 residue) are surfaced separately with the purge hint.
        const legacy: Array<{
          engram_a: { id: string; statement: string; type: string }
          engram_b: { id: string; statement: string; type: string }
          detected_at: string
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
            legacy.push({
              engram_a: { id: engram.id, statement: engram.statement, type: engram.type },
              engram_b: { id: other.id, statement: other.statement, type: other.type },
              detected_at: engram.activation.last_accessed,
            })
          }
        }

        return {
          tensions: records,
          count: records.length,
          ...(legacy.length > 0 ? {
            legacy_conflicts: legacy,
            purge_hint: 'legacy_conflicts are unvalidated relations.conflicts refs (importer heuristics or pre-#138 residue) — run scan:true to judge them, or plur_tensions_purge to clear them.',
          } : {}),
          ...(records.length === 0 && legacy.length === 0
            ? { hint: 'No persisted tensions. Run scan:true to detect contradictions.' }
            : {}),
        }
      },
    },

    {
      name: 'plur_tensions_purge',
      description: 'Purge all conflict relations from local engrams — removes accumulated false positives from the legacy tension-detection system',
      annotations: { title: 'Purge Tensions', destructiveHint: true, idempotentHint: true },
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, plur) => {
        const result = await plur.purgeTensions()
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
        const engram = await plur.episodeToEngram(args.episode_id as string, {
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
        const status = await plur.status()
        const months = listHistoryMonths(status.storage_root)
        const allEvents: HistoryEvent[] = []
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
        let engrams = await plur.list({
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
        const status = await plur.status()
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
        const engrams = await plur.list({ scope: args.scope as string | undefined })
        const profile = await generateProfile(engrams, llm, storagePath, status.config?.profile?.cache_ttl_hours ?? 24)
        return { profile, source: 'generated', engram_count: engrams.length, model }
      },
    },
  ]
}
