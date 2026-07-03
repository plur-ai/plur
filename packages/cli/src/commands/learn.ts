import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let statement = ''
  // No hardcoded scope (#353): when --scope is absent the scope key is OMITTED
  // from the LearnContext entirely so it flows through the unscoped-routing logic
  // (_guardSensitiveScope → _resolveUnscopedScope → auto-route or unscoped_default,
  // default global). Passing scope:'global' here would bypass that.
  let scope: string | undefined = undefined
  let scopeProvided = false
  let type: 'behavioral' | 'terminological' | 'procedural' | 'architectural' = 'behavioral'
  let domain: string | undefined
  let source: string | undefined
  // #8: Hermes' write path is the CLI bridge, and it SENDS these fields
  // (bridge.py learn() → --tags/--rationale/--visibility/--knowledge-anchors/
  // --dual-coding/--abstract/--derived-from). Before this, the parser only knew
  // --scope/--type/--domain/--source and silently dropped the rest, so
  // Hermes-built rationale/dual-coding/tags never reached the engram — and the
  // PR-5 context-field leak scan had nothing to scan on the CLI/Hermes path.
  // Parse them here and forward them in the LearnContext so the CLI surface
  // matches the MCP/Plur-class field set.
  let rationale: string | undefined
  let tags: string[] | undefined
  let visibility: 'private' | 'public' | 'template' | undefined
  let abstract: string | undefined
  let derivedFrom: string | undefined
  let knowledgeAnchors: Array<{ path: string; relevance?: string; snippet?: string }> | undefined
  let dualCoding: { example?: string; analogy?: string } | undefined
  // #240: engram IDs this statement intentionally replaces (comma-separated).
  let supersedes: string[] | undefined

  // Parse a value as JSON, exiting 1 with a clear message on malformed input
  // (a bad --dual-coding/--knowledge-anchors should fail loudly, not silently
  // drop the field as before).
  const parseJsonFlag = <T>(flag: string, raw: string): T => {
    try {
      return JSON.parse(raw) as T
    } catch {
      exit(1, `Error: ${flag} expects valid JSON, got: ${raw}`)
      throw new Error('unreachable') // exit() terminates; satisfies the type
    }
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; scopeProvided = true; i++ }
    else if (arg === '--type' && i + 1 < args.length) { type = args[++i] as typeof type; i++ }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--source' && i + 1 < args.length) { source = args[++i]; i++ }
    else if (arg === '--rationale' && i + 1 < args.length) { rationale = args[++i]; i++ }
    else if (arg === '--tags' && i + 1 < args.length) {
      tags = args[++i].split(',').map(t => t.trim()).filter(Boolean); i++
    }
    else if (arg === '--visibility' && i + 1 < args.length) { visibility = args[++i] as typeof visibility; i++ }
    else if (arg === '--abstract' && i + 1 < args.length) { abstract = args[++i]; i++ }
    else if (arg === '--derived-from' && i + 1 < args.length) { derivedFrom = args[++i]; i++ }
    else if (arg === '--knowledge-anchors' && i + 1 < args.length) {
      knowledgeAnchors = parseJsonFlag('--knowledge-anchors', args[++i]); i++
    }
    else if (arg === '--dual-coding' && i + 1 < args.length) {
      dualCoding = parseJsonFlag('--dual-coding', args[++i]); i++
    }
    else if (arg === '--supersedes' && i + 1 < args.length) {
      supersedes = args[++i].split(',').map(t => t.trim()).filter(Boolean); i++
    }
    else if (!statement) { statement = arg; i++ }
    else { i++ }
  }

  // Read from stdin if no positional argument
  if (!statement && !process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    statement = Buffer.concat(chunks).toString('utf-8').trim()
  }

  if (!statement) {
    exit(1, 'Usage: plur learn <statement> [--scope <scope>] [--type <type>] [--domain <domain>] ' +
      '[--source <s>] [--rationale <r>] [--tags a,b,c] [--visibility private|public|template] ' +
      '[--abstract <id>] [--derived-from <id>] [--knowledge-anchors <json>] [--dual-coding <json>] ' +
      '[--supersedes id1,id2]')
  }

  // Build the context conditionally: when --scope is absent, OMIT the scope key
  // (not scope:'global', not scope:undefined) — _guardSensitiveScope checks
  // `context?.scope == null`, which is true for an absent key, reaching the
  // unscoped routing path. When --scope is present it is honored as-is.
  // Forward the parsed context fields. Only include a key when it was actually
  // provided so an absent flag stays absent in the LearnContext (matches the
  // scope-omission contract above and avoids planting undefined keys that the
  // core defaults would otherwise resolve).
  const ctx = {
    type,
    domain,
    source,
    ...(scopeProvided ? { scope } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(abstract !== undefined ? { abstract } : {}),
    ...(derivedFrom !== undefined ? { derived_from: derivedFrom } : {}),
    ...(knowledgeAnchors !== undefined ? { knowledge_anchors: knowledgeAnchors } : {}),
    ...(dualCoding !== undefined ? { dual_coding: dualCoding } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
  }

  // ALWAYS use learnRouted (not learn): learn() stamps _demoted but does NOT do
  // remote-outbox routing for shared scopes; only learnRouted() does — so an
  // explicit `--scope group:engineering` on learn() would silently drop the
  // remote push.
  //
  // learnRouted BLOCKS on the network for remote-scoped engrams (it awaits the
  // POST to the remote store); the unscoped no-covers path falls to
  // local/global (personal) and does NOT touch a remote, so it returns
  // promptly. A 5s timeout guards against a dead/slow remote hanging the CLI.
  let engram
  // Hold the timer handle so it can be cleared on success — an un-cleared 5s
  // setTimeout would keep Node's event loop alive and hang the CLI for 5s after
  // learnRouted resolves (the unscoped/personal path returns immediately).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    engram = await Promise.race([
      plur.learnRouted(statement, ctx),
      new Promise<never>((_, rej) => {
        timeoutHandle = setTimeout(
          () => rej(new Error('learnRouted timed out after 5s — remote store slow/unreachable; engram not confirmed remotely')),
          5000,
        )
      }),
    ])
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const msg = err instanceof Error ? err.message : String(err)
    // The local write may still have completed on the remote-failure outbox
    // path; this only reports that the engram was NOT confirmed remotely.
    if (shouldOutputJson(flags)) {
      outputJson({ error: msg })
      exit(1)
    } else {
      exit(1, `Error: ${msg}`)
    }
    return
  }
  if (timeoutHandle) clearTimeout(timeoutHandle)

  // LOW-10 (#353): surface a scope demotion instead of swallowing it silently.
  // When learnRouted demotes a sensitive shared-scope write to local/private it
  // stamps structured_data._demoted; mirror the MCP display contract (tools.ts)
  // so the CLI user sees why the engram did not land at the requested scope.
  const demoted = (engram as { structured_data?: { _demoted?: { from: string; to: string; patterns: string } } })
    .structured_data?._demoted

  if (shouldOutputJson(flags)) {
    outputJson({
      id: engram.id,
      statement: engram.statement,
      scope: engram.scope,
      type: engram.type,
      domain: engram.domain ?? null,
      // Include the demotion only when it happened; include requested_scope ONLY
      // when --scope was passed, to avoid a confusing requested_scope on an
      // unscoped write that demoted from the resolved default.
      ...(demoted
        ? { demoted: { from: demoted.from, to: demoted.to, patterns: demoted.patterns }, ...(scopeProvided ? { requested_scope: demoted.from } : {}) }
        : {}),
    })
  } else {
    outputText(`Learned: "${engram.statement}"`)
    outputText(`  ID: ${engram.id} | Scope: ${engram.scope} | Type: ${engram.type}${engram.domain ? ` | Domain: ${engram.domain}` : ''}`)
    if (demoted) {
      outputText(
        `  Warning: Sensitive content (${demoted.patterns}) detected — stored at ` +
        `${demoted.to}/private instead of ${demoted.from}; re-scope deliberately if false positive.`,
      )
    }
  }
}
