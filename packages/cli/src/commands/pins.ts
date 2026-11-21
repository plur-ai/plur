/**
 * `plur pins` — the pinned set, owner-side (overhaul D2, D3, W3).
 *
 *   plur pins [--budget N]               fit report: each pin's priority, tier, cost, whether it
 *                                        fits the pinned share, and pending pin requests
 *   plur pins priority <id> <n>          set a pin's priority (1-100, higher loads first)
 *   plur pins review                     list pending pin requests (pinning.agents: request)
 *   plur pins review approve <id...>     pin them (with the tier/priority they asked for)
 *   plur pins review reject <id...>      clear the request, leave the engram unpinned
 *   plur pins audit [--out f] [--llm-cmd c] [--budget N]
 *                                        ask the host model which pins apply to every task and
 *                                        propose short forms; writes a proposal, changes nothing
 *   plur pins apply <file> [--limit N] --yes
 *                                        apply a reviewed proposal as one journalled change
 *   plur pins undo <change-id>           undo an apply
 *
 * The CLI is the owner (see `resolveCliActor`), so its pins are never turned
 * into requests. `plur pin <id>` / `plur unpin <id>` live in pin.ts/unpin.ts
 * and share {@link runPinToggle}.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { emitPlan } from '../lib/journal-cli.js'
import {
  formatPinOverflowLine, formatPendingPinRequestsLine, validatePinAuditProposal, PinDeniedError,
  pinRequestOf, type PinFitReport, type PendingPinRequest,
} from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { remoteOnlyCommandRefusal } from '../lib/folder-gate.js'
import { resolveLlmOrExit, missingLlmMessage, takeLlmFlag, UNSPECIFIED_MODEL, type LlmBridgeOptions } from '../lib/llm-bridge.js'
import { requirePinPolicyConfirmation, confirmUndoPins } from '../lib/pin-confirm.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'

export const FLAGS = ['--budget', '--out', '--llm-cmd', '--llm-base-url', '--llm-api-key', '--llm-api-key-env', '--model', '--limit', '--yes', '--scope']
export const FLAGS_WITH_VALUES = ['--budget', '--out', '--llm-cmd', '--llm-base-url', '--llm-api-key', '--llm-api-key-env', '--model', '--limit', '--scope']

const USAGE = [
  'Usage: plur pins [--budget N]',
  '       plur pins priority <id> <1-100>',
  '       plur pins review [approve|reject <id...>]',
  '       plur pins audit [--out <file>] [--llm-cmd "<cmd>"] (or PLUR_LLM_CMD)',
  '                       [--llm-base-url <https-url> --llm-api-key-env <VAR> --model <name>]',
  '       plur pins apply <proposal-file> [--limit N] --yes',
  '       plur pins undo <change-id>',
].join('\n')

interface Parsed { positional: string[]; budget?: number; out?: string; llm: LlmBridgeOptions; limit?: number; yes: boolean; scope?: string }

function parse(args: string[]): Parsed {
  const p: Parsed = { positional: [], llm: {}, yes: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const value = () => {
      if (i + 1 >= args.length) exit(1, `${a} requires a value\n${USAGE}`)
      return args[++i]
    }
    if (a === '--budget') {
      const n = Number(value())
      if (!Number.isInteger(n) || n <= 0) exit(1, '--budget must be a positive whole number of tokens')
      p.budget = n
    } else if (a === '--out') p.out = value()
    else if (a === '--limit') {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 1) exit(1, '--limit must be a whole number of at least 1')
      p.limit = n
    } else if (a === '--scope') p.scope = value()
    else if (a === '--yes') p.yes = true
    else if (!takeLlmFlag(a, value, p.llm)) p.positional.push(a)
  }
  return p
}

const short = (s: string, n = 70) => s.length > n ? `${s.slice(0, n - 1)}…` : s

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const p = parse(args)
  const [sub, ...rest] = p.positional
  switch (sub) {
    case undefined:
    case 'list': return await report(p, flags)
    case 'priority': return await priority(rest, flags)
    case 'review': return await review(rest, flags)
    case 'audit': return await audit(p, flags)
    case 'apply': return await apply(rest, p, flags)
    case 'undo': return await undo(rest, flags)
    default: exit(1, `Unknown pins subcommand: ${sub}\n${USAGE}`)
  }
}

/** The text form of `plur pins` (exported for tests: a piped CLI prints JSON). */
export function printReport(r: PinFitReport, pending: PendingPinRequest[]): void {
  outputText(`Pinned share: ${r.used} of ${r.share} tokens used (pinned_ratio ${r.pinned_ratio} of a ${r.budget}-token budget); `
    + `all pins together cost ${r.total_cost} tokens (${Math.round(r.load_ratio * 100)}% of the budget).`)
  outputText(`${r.count} pin${r.count === 1 ? '' : 's'}, ${r.overflow_count} do not fit. In injection order:`)
  if (r.count > 0) {
    outputText('')
    outputText('  fits  prio  tier  tokens  id                       statement')
    for (const e of r.entries) {
      const prio = e.tier === 'hard' ? '  - ' : `${String(e.priority).padStart(3)}${e.priority_set ? ' ' : '*'}`
      outputText(`  ${e.fits ? 'yes ' : 'NO  '}  ${prio}  ${e.tier.padEnd(4)}  ${String(e.cost).padStart(6)}  ${e.id.padEnd(24)} `
        + `${e.prohibition ? '[prohibition] ' : ''}${e.origin !== 'local' ? `[${e.origin}] ` : ''}${short(e.statement)}`)
    }
    outputText('  (* = default priority 50; ties load prohibitions first, then oldest first)')
  }
  const overflow = formatPinOverflowLine(r)
  if (overflow) {
    outputText('')
    outputText(`⚠  ${overflow}`)
    outputText('   Fix: give the pins that matter a higher priority (plur pins priority <id> <n>), unpin situational ones')
    outputText('   (plur pins audit proposes which), or raise injection_budget / injection.pinned_ratio.')
  }
  if (pending.length > 0) {
    outputText('')
    outputText(formatPendingPinRequestsLine(pending))
    for (const q of pending) outputText(`  ${q.id}  (${q.request.by}, ${q.request.requested_at.slice(0, 10)})  ${short(q.statement)}`)
  }
}

async function report(p: Parsed, flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags, { readonly: true })
  const r = await plur.pinFitReport(p.budget ? { budget: p.budget } : undefined)
  const pending = await plur.pendingPinRequests()
  if (shouldOutputJson(flags)) { outputJson({ ...r, pending_requests: pending }); return }
  printReport(r, pending)
}

async function priority(rest: string[], flags: GlobalFlags): Promise<void> {
  const [id, raw] = rest
  if (!id || raw === undefined) exit(1, `Usage: plur pins priority <id> <1-100>`)
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 100) exit(1, `Priority must be a whole number from 1 to 100, got ${raw}`)
  const plur = createPlur(flags)
  try {
    const e = await plur.setPinPriority(id, n)
    if (!e) exit(1, `Engram not found: ${id}`)
    if (shouldOutputJson(flags)) outputJson({ id: e.id, pinned_priority: (e as { pinned_priority?: number }).pinned_priority })
    else outputInfo(`Priority of ${e.id} set to ${n}.`, flags)
  } catch (err) {
    exit(1, (err as Error).message)
  }
}

async function review(rest: string[], flags: GlobalFlags): Promise<void> {
  const [verb, ...ids] = rest
  if (verb === undefined) {
    const plur = createPlur(flags, { readonly: true })
    const pending = await plur.pendingPinRequests()
    if (shouldOutputJson(flags)) { outputJson({ pending }); return }
    if (pending.length === 0) { outputText('No pin requests waiting.'); return }
    outputText(formatPendingPinRequestsLine(pending))
    for (const q of pending) {
      outputText('')
      outputText(`  ${q.id}  [${q.scope}]  asked by ${q.request.by} on ${q.request.requested_at.slice(0, 10)}${q.request.via ? ` via ${q.request.via}` : ''}`)
      outputText(`    ${q.statement}`)
      if (q.request.reason) outputText(`    reason: ${q.request.reason}`)
    }
    outputText('')
    outputText('Approve with `plur pins review approve <id...>`, reject with `plur pins review reject <id...>`.')
    return
  }
  if ((verb !== 'approve' && verb !== 'reject') || ids.length === 0) exit(1, 'Usage: plur pins review [approve|reject <id...>]')
  const plur = createPlur(flags)
  if (verb === 'approve') await requirePinPolicyConfirmation(plur, `Approve ${ids.length} pin request${ids.length === 1 ? '' : 's'}`)
  const results: Array<{ id: string; status: 'pinned' | 'rejected' | 'error' | 'requested'; error?: string }> = []
  for (const id of ids) {
    try {
      const e = verb === 'approve' ? await plur.approvePinRequest(id, { actor: plur.defaultActor }) : await plur.rejectPinRequest(id, { actor: plur.defaultActor })
      if (!e) results.push({ id, status: 'error', error: 'not found in the local store' })
      else if (verb === 'reject') results.push({ id, status: 'rejected' })
      else results.push({ id, status: e.pinned === true ? 'pinned' : 'requested' })
    } catch (err) {
      results.push({ id, status: 'error', error: (err as Error).message })
    }
  }
  const failed = results.some(r => r.status === 'error')
  if (shouldOutputJson(flags)) outputJson({ results })
  else {
    for (const r of results) outputText(r.status === 'error' ? `${r.id}: ERROR — ${r.error}` : `${r.id}: ${r.status}`)
    if (verb === 'approve') await printOverflowIfAny(plur, flags)
  }
  if (failed) exit(1)
}

async function printOverflowIfAny(plur: ReturnType<typeof createPlur>, flags: GlobalFlags): Promise<void> {
  try {
    const line = formatPinOverflowLine(await plur.pinFitReport())
    if (line && !shouldOutputJson(flags)) outputText(`⚠  ${line}`)
  } catch { /* advisory only */ }
}

async function audit(p: Parsed, flags: GlobalFlags): Promise<void> {
  const refused = remoteOnlyCommandRefusal(flags, 'A pin audit sends memories to a model, which is not the team server')
  if (refused) exit(1, refused)
  const bridge = resolveLlmOrExit(p.llm)
  if (!bridge) exit(1, missingLlmMessage('plur pins audit'))
  // Read-only engine: the audit changes nothing in the store.
  const plur = createPlur(flags, { readonly: true })
  // S6: by default next to the store it audits, never into the current folder
  // (a repository, where a proposal quoting memory text could be committed).
  const out = p.out ?? join(plur.storageRoot, `pin-audit-${new Date().toISOString().slice(0, 10)}.json`)
  let proposal
  try {
    proposal = await plur.auditPins(bridge.llm, {
      // A command bridge with no model name records the command, as before.
      model: bridge.command && bridge.model === UNSPECIFIED_MODEL ? bridge.command : bridge.model,
      onProgress: (done, total) => outputInfo(`  audited ${done}/${total} pins`, flags),
    })
  } catch (err) {
    exit(1, `Pin audit failed: ${(err as Error).message}`)
  }
  emitPlan(proposal, out)
  const count = (a: string) => proposal.items.filter(i => i.action === a).length
  const needApproval = proposal.items.filter(i => i.action === 'shorten' && i.prohibition).length
  if (shouldOutputJson(flags)) { outputJson({ out, ...proposal }); return }
  outputText(`Wrote ${out}: ${proposal.items.length} pins — ${count('unpin')} situational (unpin), ${count('shorten')} every-task with a `
    + `short form, ${count('keep')} kept${proposal.unanswered.length ? ` (${proposal.unanswered.length} without a usable answer, kept)` : ''}.`)
  outputText('Nothing was changed. Review the file: edit any item\'s "action" (unpin | shorten | keep) or "short_form".')
  if (needApproval > 0) {
    outputText(`${needApproval} short form${needApproval === 1 ? ' is' : 's are'} for prohibitions: each applies only after you set "approved": true on it.`)
  }
  outputText(`Then try one: plur pins apply ${out} --limit 1 --yes   (undo: plur pins undo <change-id>)`)
}

async function apply(rest: string[], p: Parsed, flags: GlobalFlags): Promise<void> {
  const [file] = rest
  if (!file) exit(1, 'Usage: plur pins apply <proposal-file> [--limit N] --yes')
  // S1: under a restrictive pinning policy, a terminal confirmation first.
  if (p.yes) await requirePinPolicyConfirmation(createPlur(flags, { readonly: true }), `Apply the pin audit ${file}`)
  if (!existsSync(file)) exit(1, `No such file: ${file}`)
  let proposal
  try {
    proposal = validatePinAuditProposal(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    exit(1, `Cannot read the proposal: ${(err as Error).message}`)
  }
  const changing = proposal.items.filter(i => i.action !== 'keep').length
  if (!p.yes) {
    exit(1, `plur pins apply changes up to ${p.limit !== undefined ? Math.min(p.limit, changing) : changing} engram(s) in your store. `
      + 'Re-run with --yes to apply (start with --limit 1 for a one-item trial; every apply can be undone with plur pins undo <change-id>).')
  }
  const plur = createPlur(flags)
  let result
  try {
    result = await plur.applyPinAudit(proposal, { ...(p.limit !== undefined ? { limit: p.limit } : {}), actor: plur.defaultActor })
  } catch (err) {
    exit(1, `Apply failed, nothing was changed: ${(err as Error).message}`)
  }
  const applied = result.outcomes.filter(o => o.status === 'applied')
  const refused = result.outcomes.filter(o => o.status === 'refused')
  if (shouldOutputJson(flags)) { outputJson({ change_id: result.change?.id ?? null, outcomes: result.outcomes }); return }
  for (const o of result.outcomes) {
    if (o.action === 'keep') continue
    outputText(`${o.id}: ${o.action} — ${o.status}${o.detail ? ` (${o.detail})` : ''}`)
  }
  outputText(applied.length > 0
    ? `Applied ${applied.length} change${applied.length === 1 ? '' : 's'} as ${result.change!.id}. Undo with: plur pins undo ${result.change!.id}`
    : 'Nothing was applied.')
  if (refused.length > 0) outputText(`${refused.length} item${refused.length === 1 ? ' was' : 's were'} refused — see above.`)
}

async function undo(rest: string[], flags: GlobalFlags): Promise<void> {
  const [id] = rest
  if (!id) exit(1, 'Usage: plur pins undo <change-id>')
  const plur = createPlur(flags)
  const change = plur.getChange(id)
  if (!change) exit(1, `No change ${id} in the change journal.`)
  if (change.kind !== 'pins.apply') exit(1, `${id} is a "${change.kind}" change, not a pins apply; plur pins undo only undoes pins applies.`)
  // H12: undoing an unpin pins the engram again (S1).
  await confirmUndoPins(plur, change)
  try {
    const record = await plur.undoChange(id)
    if (shouldOutputJson(flags)) outputJson({ undone: id, change_id: record.id, rows: record.rows.length })
    else outputInfo(`Undid ${id} (${record.rows.length} engram${record.rows.length === 1 ? '' : 's'} restored) as ${record.id}.`, flags)
  } catch (err) {
    exit(1, (err as Error).message)
  }
}

/** `plur pin <id>` / `plur unpin <id>`: the owner's pin toggle. */
export async function runPinToggle(pinned: boolean, args: string[], flags: GlobalFlags): Promise<void> {
  const p = parse(args)
  const [id] = p.positional
  const verb = pinned ? 'pin' : 'unpin'
  if (!id || p.positional.length > 1) exit(1, `Usage: plur ${verb} <id> [--scope <scope>]`)
  const plur = createPlur(flags)
  if (pinned) await requirePinPolicyConfirmation(plur, `Pin ${id}`)
  try {
    const e = await plur.setPinned(id, pinned, { ...(p.scope ? { scope: p.scope } : {}), actor: plur.defaultActor })
    if (!e) exit(1, `Engram not found: ${id}`)
    const request = pinned ? pinRequestOf(e) : null
    if (shouldOutputJson(flags)) {
      outputJson({ id: e.id, statement: e.statement, pinned: e.pinned === true, ...(request ? { pin_request: request } : {}) })
      return
    }
    if (request) outputText(`${e.id} was NOT pinned: this command runs as an agent (PLUR_ACTOR=agent), so a pin request was recorded for the owner.`)
    else outputInfo(`${pinned ? 'Pinned' : 'Unpinned'}: [${e.id}] ${e.statement}`, flags)
    if (pinned && !request) await printOverflowIfAny(plur, flags)
  } catch (err) {
    if (err instanceof PinDeniedError) exit(1, err.message)
    exit(1, (err as Error).message)
  }
}
