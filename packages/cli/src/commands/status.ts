import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'
import { describeNeedsAction, describeHeld, type StoreHealth } from '@plur-ai/core'

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  // Pure query — a read-only engine guarantees no lazy write side-effects.
  const plur = createPlur(flags, { readonly: true })
  const result = await plur.status()
  // Store health (overhaul W6): size, sampled near-copy share, pin load. Read
  // only and model-free (cached vectors only); never fails the status.
  let health: StoreHealth | null = null
  let healthError: string | undefined
  try { health = await plur.storeHealth() } catch (err: unknown) { health = null; healthError = (err as Error)?.message ?? String(err) }

  if (shouldOutputJson(flags)) {
    outputJson({ ...result, ...(health ? { store_health: health } : {}), ...(healthError !== undefined ? { store_health_error: healthError } : {}) })
  } else {
    // The banner is decoration and --quiet suppresses it; the fields below are
    // the primary output and always print.
    outputInfo('Plur Status', flags)
    outputInfo('===========', flags)
    outputText(`  Engrams:      ${result.engram_count}`)
    outputText(`  Episodes:     ${result.episode_count}`)
    outputText(`  Packs:        ${result.pack_count}`)
    // Injection-provenance event and outcome-label counts.
    const ev = result.history_events
    if (ev) {
      outputText(`  Events:       co_injection ${ev.co_injection} · outcomes ${ev.injection_outcome} (+${ev.outcome_positive}/-${ev.outcome_negative})`)
    }
    outputText(`  Storage root: ${result.storage_root}`)
    if (health) {
      const nc = health.near_copy
      outputText(`  Store health: ${health.active} active of ${health.rows} rows`)
      outputText(nc.available
        ? `    Near-copies: ${(nc.share_090 * 100).toFixed(0)}% at >= 0.90, ${(nc.share_085 * 100).toFixed(0)}% at >= 0.85 (sample of ${nc.sample_size}, seed ${nc.seed})`
        : `    Near-copies: not measured (${nc.reason})`)
      outputText(`    Pins: ${health.pins.count} pinned, ${health.pins.tokens} of ${health.pins.share_tokens} tokens (${Math.round(health.pins.pinned_ratio * 100)}% share)`
        + (health.pins.over_share ? ' — over the share' : ''))
    } else if (healthError !== undefined) {
      // H15: say it, rather than leave the section out.
      outputText(`  Store health: could not read: ${healthError}`)
    }
    // Queued writes are otherwise invisible here, and the ones no retry will
    // deliver are exactly the ones a person has to act on.
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
    // Say why writes are held, not just that they retry.
    for (const line of describeHeld({ pending: 0, retrying: 0, needs_action: 0, scopes: [], held: result.outbox_held })) {
      outputText(`  ⚠️  ${line}`)
    }
    // Discoverability, not decoration: the dashboard is on-demand by design
    // (it serves the whole store with no auth, so nothing auto-starts it),
    // which means the one place a user learns it exists is a hint like this.
    outputInfo('  Browse it:    plur dashboard', flags)
    // A store PLUR could not read must be visible here: otherwise a corrupt
    // registry would print as a healthy `Packs: 0`.
    if (result.store_errors) {
      outputText('')
      for (const [name, message] of Object.entries(result.store_errors)) {
        outputText(`  ⚠️  ${name}: unreadable`)
        for (const line of String(message).split('\n')) outputText(`      ${line}`)
      }
    }
  }
}
