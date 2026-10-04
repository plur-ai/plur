import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { folderReadContext } from '../lib/folder-gate.js'

// Note: the supersedes rule assumes the consumer has PLUR MCP tools available
// (plur_learn). Consumers without MCP tooling can opt out via
// --no-with-default-protocol.
export const DEFAULT_PROTOCOL = `## Learning Protocol
Each response must end with a 🧠 I learned block recording reusable insights, unless the response is [ACK] or pure tool output.
---
🧠 I learned:
- <insight (min 10 chars)>
- <insight>
---
Supersedes rule: if this 🧠 corrects a previous engram, call: plur_learn(statement="...", supersedes=["ENG-xxx"], source="<bot_name>")
Skip the block only when truly nothing new was discovered.`

/**
 * Flags this command accepts (#986). Declaring them turns on the argv check,
 * so a flag inject cannot honour (`--domain`: MCP `plur_inject` takes no
 * domain either) is refused rather than silently ignored — which is what
 * happened to `--scope` before it was wired through.
 */
export const FLAGS_WITH_VALUES = ['--budget', '--scope']

export const FLAGS = ['--budget', '--scope', '--no-with-default-protocol']

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let task = ''
  let budget = 2000
  let scope: string | undefined
  let withProtocol = true

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--budget' && i + 1 < args.length) { budget = parseInt(args[++i], 10); i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--no-with-default-protocol') { withProtocol = false; i++ }
    // `--` ends flag parsing: the next token is the task, verbatim, even when
    // it starts with `-` (decision S4; formal r2 follow-up). Before, `--`
    // itself became the task.
    else if (arg === '--') { if (!task && i + 1 < args.length) task = args[i + 1]; break }
    else if (!task) { task = arg; i++ }
    else { i++ }
  }

  if (!task) {
    exit(1, 'Usage: plur inject <task> [--budget <n>] [--scope <scope>] [--no-with-default-protocol]')
  }

  // Same semantics as MCP plur_inject / plur_inject_hybrid: `scope` filters
  // engram selection, and on the hybrid path it is the remote leg's dialing
  // context (#243/#776).
  // Without --scope, the folder's scope is the dialing context (L10), by the
  // same rule as MCP plur_inject_hybrid (#1566). `dial_session`, not
  // `session_id`: the internal key is never recorded as a session. The
  // keyword path (--fast) never dials, as before. An off folder, an
  // undecided one (unscoped) or a broken folder map contacts no store at all.
  const { session: dial_session, remote } = folderReadContext(plur, scope)
  const result = flags.fast
    ? await plur.inject(task, { budget, scope })
    : await plur.injectHybrid(task, { budget, scope, dial_session, remote })

  // Append default learning protocol to directives (opt-out via --no-with-default-protocol)
  let directives = result.directives || ''
  if (withProtocol) {
    directives = directives ? `${directives}\n\n${DEFAULT_PROTOCOL}` : DEFAULT_PROTOCOL
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      directives,
      constraints: result.constraints,
      consider: result.consider,
      count: result.count,
      tokens_used: result.tokens_used,
      // #1142: pinned engrams the budget dropped. Absent when none were.
      ...(result.omitted_pinned?.length ? { omitted_pinned: result.omitted_pinned } : {}),
      // #1586 audit L6: what the server leg did on this call (added fields).
      // The keyword path (--fast) never dials.
      remote: result.remote ?? { state: 'not_dialed', hosts: [] },
      results_complete: result.results_complete ?? true,
      ...(result.mode ? { mode: result.mode } : {}),
      ...(result.degraded_reason ? { degraded_reason: result.degraded_reason } : {}),
      ...(result.mode === 'hybrid-degraded' && result.embedder_error ? { embedder_error: result.embedder_error } : {}),
    })
  } else {
    // CONSTRAINTS FIRST — matches @plur-ai/mcp and @plur-ai/dsh. Consumers
    // truncate head-first, so prohibitions must lead. See memory-section.ts.
    if (result.constraints) {
      outputText('## CONSTRAINTS')
      outputText(result.constraints)
    }
    if (directives) {
      outputText('## DIRECTIVES')
      outputText(directives)
    }
    if (result.consider) {
      outputText('## ALSO CONSIDER')
      outputText(result.consider)
    }
    outputInfo(`\nInjected ${result.count} engrams (${result.tokens_used} tokens)`, flags)
    // #1142: say what was pinned and did not fit. A pin the user set and the
    // budget dropped is the case where silence costs most — they believe a
    // standing rule is loaded.
    if (result.omitted_pinned?.length) {
      outputInfo(
        `${result.omitted_pinned.length} pinned engram(s) did NOT fit: `
        + result.omitted_pinned.map(o => `${o.id} (${o.cost}t, ${o.reason})`).join(', '),
        flags,
      )
    }
  }
}
