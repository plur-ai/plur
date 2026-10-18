import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'
import { describeNeedsAction, describeHeld } from '@plur-ai/core'

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  // Pure query — a read-only engine guarantees no lazy write side-effects.
  const plur = createPlur(flags, { readonly: true })
  const result = await plur.status()

  if (shouldOutputJson(flags)) {
    outputJson(result)
  } else {
    // Banner is decoration → suppressed by --quiet; the fields below are the
    // primary output and always print (#730).
    outputInfo('Plur Status', flags)
    outputInfo('===========', flags)
    outputText(`  Engrams:      ${result.engram_count}`)
    outputText(`  Episodes:     ${result.episode_count}`)
    outputText(`  Packs:        ${result.pack_count}`)
    // Injection-provenance event/label counts (#452) — #202's volume gate.
    const ev = result.history_events
    if (ev) {
      outputText(`  Events:       co_injection ${ev.co_injection} · outcomes ${ev.injection_outcome} (+${ev.outcome_positive}/-${ev.outcome_negative})`)
    }
    outputText(`  Storage root: ${result.storage_root}`)
    // #1299: queued writes are otherwise invisible here — and the ones no
    // retry will deliver are exactly the ones a person has to act on.
    if (result.outbox_count) {
      const needs = result.outbox_needs_action ?? 0
      outputText(`  Outbox:       ${result.outbox_count} queued` + (needs > 0 ? ` (${needs} need action)` : ''))
    }
    if (result.outbox_attention && result.outbox_attention.length > 0) {
      outputText('')
      const needs = result.outbox_attention.reduce((n, s) => n + s.count, 0)
      for (const line of describeNeedsAction({ pending: result.outbox_count ?? 0, retrying: 0, needs_action: needs, scopes: result.outbox_attention })) {
        outputText(`  ⚠️  ${line}`)
      }
      outputText('      Nothing is dropped automatically. `plur outbox` lists them.')
    }
    // #1581 audit L1: say why writes are held here, not just that they retry.
    for (const line of describeHeld({ pending: 0, retrying: 0, needs_action: 0, scopes: [], held: result.outbox_held })) {
      outputText(`  ⚠️  ${line}`)
    }
    // Discoverability, not decoration: the dashboard is on-demand by design
    // (it serves the whole store with no auth, so nothing auto-starts it),
    // which means the one place a user learns it exists is a hint like this.
    outputInfo('  Browse it:    plur dashboard', flags)
    // A store PLUR could not read must be visible here above all places (audit
    // 2026-08-03, finding 14). Core reports these and the text surface dropped
    // them, so a corrupt registry printed as a healthy `Packs: 0` — the same
    // silence the refuse-on-corrupt work exists to remove.
    if (result.store_errors) {
      outputText('')
      for (const [name, message] of Object.entries(result.store_errors)) {
        outputText(`  ⚠️  ${name}: unreadable`)
        for (const line of String(message).split('\n')) outputText(`      ${line}`)
      }
    }
  }
}
