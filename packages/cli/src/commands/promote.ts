import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  const id = args[0]
  if (!id) {
    exit(1, 'Usage: plur promote <engram-id>')
  }

  const engram = plur.getById(id)
  if (!engram) {
    exit(1, `Engram not found: ${id}`)
  }

  if (engram.status === 'active') {
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, id, status: 'already_active' })
    } else {
      outputText(`Engram ${id} is already active`)
    }
    return
  }

  if (engram.status === 'retired') {
    exit(1, `Cannot promote retired engram: ${id}`)
  }

  engram.status = 'active'
  engram.activation.retrieval_strength = 0.7
  engram.activation.storage_strength = 1.0
  engram.activation.last_accessed = new Date().toISOString().split('T')[0]
  plur.updateEngram(engram)

  if (shouldOutputJson(flags)) {
    outputJson({ success: true, id, statement: engram.statement, status: 'promoted' })
  } else {
    outputText(`Promoted engram: ${id}`)
  }
}
