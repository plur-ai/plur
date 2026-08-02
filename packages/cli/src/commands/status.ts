import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
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
  }
}
