import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputInfo, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  // `plur promote <id> --to <scope>` is a scope MOVE, not candidate activation —
  // delegate to the rescope command so both spellings work (#676). Without
  // `--to`, promote keeps its historical meaning: activate a candidate engram.
  if (args.includes('--to')) {
    const { run: rescopeRun } = await import('./rescope.js')
    await rescopeRun(args, flags)
    return
  }

  const plur = createPlur(flags)

  const id = args[0]
  if (!id) {
    exit(1, 'Usage: plur promote <engram-id>              (activate a candidate)\n' +
            '       plur promote <engram-id> --to <scope>  (move to another scope — alias of plur rescope)')
  }

  const engram = await plur.getById(id)
  if (!engram) {
    exit(1, `Engram not found: ${id}`)
  }

  if (engram.status === 'active') {
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, id, status: 'already_active' })
    } else {
      outputInfo(`Engram ${id} is already active`, flags)
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
  await plur.updateEngram(engram)

  if (shouldOutputJson(flags)) {
    outputJson({ success: true, id, statement: engram.statement, status: 'promoted' })
  } else {
    outputInfo(`Promoted engram: ${id}`, flags)
  }
}
