/**
 * Pin audit (overhaul W3): sort each pin into "every task" or "situational"
 * with the host model, propose a short form for the every-task ones, and
 * apply an owner-reviewed proposal through the change journal.
 *
 * Core makes no model call of its own: the audit takes an {@link LlmFunction}
 * (the CLI builds one from `--llm-cmd` / `PLUR_LLM_CMD`), and the apply is a
 * pure store operation.
 *
 * Safety contract (the same as enrichment's):
 *   - the audit changes nothing; it returns a proposal;
 *   - apply changes only what the proposal names, journalled, undoable as one
 *     change (`plur pins undo <change-id>`);
 *   - a short form keeps the original in `structured_data.original_statement`;
 *   - a short form for a PROHIBITION is applied only when its item says
 *     `approved: true` — a person read that diff;
 *   - an item whose engram changed since the audit (statement, pin) is
 *     skipped, never applied to a row the proposal did not see.
 */
import type { Engram } from './schemas/engram.js'
import type { LlmFunction } from './types.js'
import { isProhibition } from './pin-policy.js'
import { estimateTokens } from './inject.js'
import { computeContentHash } from './content-hash.js'
import { autoSummary } from './summary.js'

export const PIN_AUDIT_PROPOSAL_KIND = 'plur.pins.audit'
export const PIN_AUDIT_PROPOSAL_VERSION = 1

export type PinAuditClass = 'every-task' | 'situational' | 'unknown'

/** One pin in a proposal. */
export interface PinAuditItem {
  id: string
  /** The statement the audit saw. Apply skips the item when the engram's statement differs. */
  statement: string
  cost: number
  prohibition: boolean
  classification: PinAuditClass
  reason?: string
  /** Proposed short form (every-task pins only). */
  short_form?: string
  /**
   * What apply does: `unpin` (situational), `shorten` (every-task with a short
   * form), `keep`. Editable by the owner before apply.
   */
  action: 'unpin' | 'shorten' | 'keep'
  /** Required `true` for `shorten` on a prohibition. Set by a person, never by the audit. */
  approved?: boolean
}

export interface PinAuditProposal {
  kind: typeof PIN_AUDIT_PROPOSAL_KIND
  version: typeof PIN_AUDIT_PROPOSAL_VERSION
  created_at: string
  /** The model command, as given (for the record). */
  model?: string
  items: PinAuditItem[]
  /** Pins the model gave no usable answer for (kept, action `keep`). */
  unanswered: string[]
}

/** Pins per model call. */
export const PIN_AUDIT_BATCH = 20

/** The prompt for one batch of pins. */
export function buildPinAuditPrompt(pins: ReadonlyArray<{ id: string; statement: string }>): string {
  const list = pins.map(p => `- id: ${p.id}\n  statement: ${JSON.stringify(p.statement)}`).join('\n')
  return [
    'You are auditing the PINNED memories of an AI coding agent. A pinned memory is injected into EVERY session,',
    'whatever the task, so each one costs context on every turn. Sort each memory into one class:',
    '',
    '- "every-task": it applies to nearly every task the agent does (a standing rule of conduct, a safety',
    '  prohibition, a global convention). It should stay pinned.',
    '- "situational": it applies only to some tasks, projects, tools or topics. It should be unpinned and',
    '  found by search when relevant.',
    '',
    'For every "every-task" memory, also propose "short_form": the same rule in as few words as possible,',
    'keeping every condition, exception, name and number that changes what the agent must do. Never weaken',
    'a prohibition. If it is already minimal, repeat it unchanged.',
    '',
    'Answer with ONLY a JSON array, one object per memory, no prose:',
    '[{"id": "<id>", "class": "every-task" | "situational", "reason": "<one short sentence>", "short_form": "<text, every-task only>"}]',
    '',
    'Memories:',
    list,
  ].join('\n')
}

/** Parse a model answer: the first JSON array in it. Lenient about code fences and prose around it. */
export function parsePinAuditResponse(text: string): Array<{ id: string; class: PinAuditClass; reason?: string; short_form?: string }> {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let raw: unknown
  try { raw = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string; class: PinAuditClass; reason?: string; short_form?: string }> = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string') continue
    const cls = o.class === 'every-task' || o.class === 'situational' ? o.class : 'unknown'
    out.push({
      id: o.id,
      class: cls,
      ...(typeof o.reason === 'string' && o.reason.trim() ? { reason: o.reason.trim() } : {}),
      ...(typeof o.short_form === 'string' && o.short_form.trim() ? { short_form: o.short_form.trim().replace(/[\r\n]+/g, ' ') } : {}),
    })
  }
  return out
}

/**
 * Build a proposal for the given pins. Calls `llm` once per batch of
 * {@link PIN_AUDIT_BATCH}. Reads nothing and writes nothing itself.
 */
export async function auditPins(
  pins: readonly Engram[],
  llm: LlmFunction,
  opts?: { model?: string; batchSize?: number; onProgress?: (done: number, total: number) => void },
): Promise<PinAuditProposal> {
  const size = Math.max(1, opts?.batchSize ?? PIN_AUDIT_BATCH)
  const answers = new Map<string, { class: PinAuditClass; reason?: string; short_form?: string }>()
  for (let i = 0; i < pins.length; i += size) {
    const batch = pins.slice(i, i + size)
    const text = await llm(buildPinAuditPrompt(batch))
    const known = new Set(batch.map(p => p.id))
    for (const a of parsePinAuditResponse(text)) if (known.has(a.id) && !answers.has(a.id)) answers.set(a.id, a)
    opts?.onProgress?.(Math.min(i + size, pins.length), pins.length)
  }
  const unanswered: string[] = []
  const items: PinAuditItem[] = pins.map(p => {
    const a = answers.get(p.id)
    if (!a || a.class === 'unknown') unanswered.push(p.id)
    const classification: PinAuditClass = a?.class ?? 'unknown'
    const shortForm = classification === 'every-task' && a?.short_form && a.short_form !== p.statement ? a.short_form : undefined
    return {
      id: p.id,
      statement: p.statement,
      cost: estimateTokens(p as never),
      prohibition: isProhibition(p),
      classification,
      ...(a?.reason ? { reason: a.reason } : {}),
      ...(shortForm ? { short_form: shortForm } : {}),
      action: classification === 'situational' ? 'unpin' : shortForm ? 'shorten' : 'keep',
    }
  })
  return {
    kind: PIN_AUDIT_PROPOSAL_KIND,
    version: PIN_AUDIT_PROPOSAL_VERSION,
    created_at: new Date().toISOString(),
    ...(opts?.model ? { model: opts.model } : {}),
    items,
    unanswered,
  }
}

/** Validate a proposal read from a file. Throws with a readable message. */
export function validatePinAuditProposal(raw: unknown): PinAuditProposal {
  if (!raw || typeof raw !== 'object') throw new Error('The proposal file is not a JSON object.')
  const p = raw as Record<string, unknown>
  if (p.kind !== PIN_AUDIT_PROPOSAL_KIND) throw new Error(`Not a pin audit proposal (kind is ${JSON.stringify(p.kind)}, expected "${PIN_AUDIT_PROPOSAL_KIND}").`)
  if (p.version !== PIN_AUDIT_PROPOSAL_VERSION) throw new Error(`Unsupported proposal version ${JSON.stringify(p.version)}.`)
  if (!Array.isArray(p.items)) throw new Error('The proposal has no items array.')
  for (const [i, it] of (p.items as unknown[]).entries()) {
    const o = it as Record<string, unknown>
    if (!o || typeof o.id !== 'string' || typeof o.statement !== 'string') throw new Error(`Item ${i} needs an id and a statement.`)
    if (o.action !== 'unpin' && o.action !== 'shorten' && o.action !== 'keep') throw new Error(`Item ${i} (${o.id}): action must be unpin, shorten or keep.`)
    if (o.action === 'shorten' && (typeof o.short_form !== 'string' || !o.short_form.trim())) throw new Error(`Item ${i} (${o.id}): shorten needs a short_form.`)
    if (o.approved !== undefined && typeof o.approved !== 'boolean') throw new Error(`Item ${i} (${o.id}): approved must be true or false.`)
  }
  return raw as PinAuditProposal
}

/** What apply did with one item. */
export interface PinApplyOutcome {
  id: string
  action: PinAuditItem['action']
  status: 'applied' | 'skipped' | 'refused'
  detail?: string
}

/**
 * Decide, for each item, what apply would do to the current row. Pure: the
 * caller stages `row` for the `applied` ones. `limit` caps the applied count.
 */
export function planPinApply(
  proposal: PinAuditProposal,
  current: (id: string) => Engram | undefined,
  opts?: { limit?: number; now?: string },
): Array<PinApplyOutcome & { row?: Engram }> {
  const limit = opts?.limit ?? Infinity
  const now = opts?.now ?? new Date().toISOString()
  let applied = 0
  const out: Array<PinApplyOutcome & { row?: Engram }> = []
  for (const item of proposal.items) {
    if (item.action === 'keep') { out.push({ id: item.id, action: 'keep', status: 'skipped', detail: 'keep' }); continue }
    const e = current(item.id)
    if (!e || e.status !== 'active') { out.push({ id: item.id, action: item.action, status: 'skipped', detail: 'not an active engram in the local store' }); continue }
    const sd = (e.structured_data ?? {}) as Record<string, unknown>
    const original = typeof sd.original_statement === 'string' ? sd.original_statement : undefined
    if (item.action === 'unpin') {
      if (e.pinned !== true) { out.push({ id: item.id, action: 'unpin', status: 'skipped', detail: 'already unpinned' }); continue }
      if (e.statement !== item.statement) { out.push({ id: item.id, action: 'unpin', status: 'skipped', detail: 'statement changed since the audit' }); continue }
      if (applied >= limit) { out.push({ id: item.id, action: 'unpin', status: 'skipped', detail: 'over --limit' }); continue }
      const row: Record<string, unknown> = { ...e, updated_at: now }
      delete row.pinned
      delete row.pinned_tier
      delete row.pinned_priority
      applied++
      out.push({ id: item.id, action: 'unpin', status: 'applied', row: row as Engram })
      continue
    }
    // shorten
    const short = (item.short_form ?? '').trim()
    if (e.statement === short && original === item.statement) { out.push({ id: item.id, action: 'shorten', status: 'skipped', detail: 'already shortened' }); continue }
    if (e.statement !== item.statement) { out.push({ id: item.id, action: 'shorten', status: 'skipped', detail: 'statement changed since the audit' }); continue }
    if (e.pinned !== true) { out.push({ id: item.id, action: 'shorten', status: 'skipped', detail: 'no longer pinned' }); continue }
    // Re-derived from the CURRENT statement, not trusted from the file: a
    // proposal edited to say `prohibition: false` cannot skip the approval.
    if ((isProhibition(e) || item.prohibition) && item.approved !== true) {
      out.push({ id: item.id, action: 'shorten', status: 'refused', detail: 'a short form for a prohibition needs "approved": true on this item (read the diff first)' })
      continue
    }
    if (applied >= limit) { out.push({ id: item.id, action: 'shorten', status: 'skipped', detail: 'over --limit' }); continue }
    const row = {
      ...e,
      statement: short,
      content_hash: computeContentHash(short),
      updated_at: now,
      structured_data: { ...sd, original_statement: original ?? e.statement },
    } as Engram
    // A summary describes the statement; re-derive it so it cannot outlive it.
    if ('summary' in e) {
      const summary = autoSummary(short, (e as { knowledge_type?: { cognitive_level?: string } }).knowledge_type?.cognitive_level)
      if (summary === undefined) delete (row as { summary?: unknown }).summary
      else (row as { summary?: unknown }).summary = summary
    }
    applied++
    out.push({ id: item.id, action: 'shorten', status: 'applied', row })
  }
  return out
}
