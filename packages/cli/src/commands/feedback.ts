import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

const VALID_SIGNALS = ['positive', 'negative', 'neutral'] as const
type Signal = (typeof VALID_SIGNALS)[number]

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  // Batch mode: plur feedback --batch '[{"id":"ENG-1","signal":"positive"},...]'
  const batchIdx = args.indexOf('--batch')
  if (batchIdx >= 0 && batchIdx + 1 < args.length) {
    const batchJson = args[batchIdx + 1]
    let items: Array<{ id: string; signal: string }>
    try {
      items = JSON.parse(batchJson)
    } catch {
      exit(1, 'Invalid --batch JSON. Expected: [{"id":"ENG-1","signal":"positive"},...]')
      return
    }

    const results: Array<{ id: string; signal: string; success: boolean; error?: string }> = []
    const summary = { positive: 0, negative: 0, neutral: 0 }
    for (const item of items) {
      if (!(VALID_SIGNALS as readonly string[]).includes(item.signal)) {
        results.push({ id: item.id, signal: item.signal, success: false, error: `Invalid signal: ${item.signal}` })
        continue
      }
      try {
        await plur.feedback(item.id, item.signal as Signal)
        results.push({ id: item.id, signal: item.signal, success: true })
        summary[item.signal as Signal]++
      } catch (err: any) {
        results.push({ id: item.id, signal: item.signal, success: false, error: err.message })
      }
    }

    if (shouldOutputJson(flags)) {
      outputJson({ mode: 'batch', results, summary })
    } else {
      outputText(`Batch feedback: ${summary.positive} positive, ${summary.negative} negative, ${summary.neutral} neutral`)
    }
    return
  }

  // Single mode: plur feedback <id> <signal>
  let id = ''
  let signal = ''

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!id) { id = arg; i++ }
    else if (!signal) { signal = arg; i++ }
    else { i++ }
  }

  if (!id || !signal) {
    exit(1, 'Usage: plur feedback <id> <signal> [or --batch <json>]')
  }

  if (!(VALID_SIGNALS as readonly string[]).includes(signal)) {
    exit(1, `Invalid signal: "${signal}". Must be one of: positive, negative, neutral`)
  }

  await plur.feedback(id, signal as Signal)

  if (shouldOutputJson(flags)) {
    outputJson({ id, signal, status: 'recorded' })
  } else {
    outputText(`Feedback recorded: ${signal} for ${id}`)
  }
}
