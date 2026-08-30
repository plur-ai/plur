import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'

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
    // Provenance identity (#1049) — surfaced so operators can confirm which
    // actor name is being stamped on writes and which stamping mode is active.
    const prov = result.config?.provenance
    if (prov?.identity) {
      const mode = prov.mode ?? 'always'
      outputText(`  Identity:     ${prov.identity} (mode: ${mode})`)
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
