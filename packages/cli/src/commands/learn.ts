import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'

/**
 * Flags this command accepts. Anything else is refused rather than silently
 * dropped.
 */
export const FLAGS_WITH_VALUES = ['--scope', '--type', '--domain', '--source', '--rationale', '--tags', '--visibility', '--abstract', '--derived-from', '--knowledge-anchors', '--dual-coding', '--supersedes', '--license', '--claim-class', '--asserted-by']

/**
 * How long `plur learn` waits for a team server before saving to the outbox,
 * in ms. The save itself is never cut short; only the server leg is.
 */
export const REMOTE_WRITE_TIMEOUT_MS = 5_000

export const FLAGS = [
  '--scope', '--type', '--domain', '--source', '--rationale', '--tags',
  '--visibility', '--abstract', '--derived-from', '--knowledge-anchors',
  '--dual-coding', '--supersedes', '--license', '--claim-class', '--asserted-by',
]

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let statement = ''
  // No hardcoded scope: when --scope is absent the scope key is OMITTED
  // from the LearnContext entirely so it flows through the unscoped-routing logic
  // (_guardSensitiveScope → _resolveUnscopedScope → auto-route or unscoped_default,
  // default global). Passing scope:'global' here would bypass that.
  let scope: string | undefined = undefined
  let scopeProvided = false
  let type: 'behavioral' | 'terminological' | 'procedural' | 'architectural' = 'behavioral'
  let domain: string | undefined
  let source: string | undefined
  // Hermes writes through this CLI and sends these fields (bridge.py learn() →
  // --tags/--rationale/--visibility/--knowledge-anchors/--dual-coding/
  // --abstract/--derived-from). They are forwarded in the LearnContext so the
  // CLI surface matches the MCP/Plur-class field set.
  let rationale: string | undefined
  let tags: string[] | undefined
  let visibility: 'private' | 'public' | 'template' | undefined
  let abstract: string | undefined
  let derivedFrom: string | undefined
  let knowledgeAnchors: Array<{ path: string; relevance?: string; snippet?: string }> | undefined
  let dualCoding: { example?: string; analogy?: string } | undefined
  // Engram IDs this statement intentionally replaces (comma-separated).
  let supersedes: string[] | undefined
  // Provenance: who is answerable for the engram, whether a person stated it
  // or a model worked it out, and which licence governs reuse.
  let license: string | undefined
  let claimClass: 'observed' | 'documented' | 'structural' | 'asserted' | 'inferred' | 'revised' | undefined
  let assertedBy: string | undefined

  /** Reject `--license --claim-class observed`, where the value is the next flag. */
  const value = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || /^--[A-Za-z]/.test(raw)) {
      exit(1, `${flag} needs a value, but the next argument was ${raw ?? '(nothing)'}.`)
    }
    return raw
  }

  // Parse a value as JSON, exiting 1 with a clear message on malformed input
  // (a bad --dual-coding/--knowledge-anchors fails loudly rather than dropping
  // the field).
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
    else if (arg === '--type' && i + 1 < args.length) {
      const v = args[++i]
      const allowed = ['behavioral', 'terminological', 'procedural', 'architectural']
      if (!allowed.includes(v)) {
        exit(1, `Unknown --type "${v}". One of: ${allowed.join(', ')}.`)
      }
      type = v as typeof type; i++
    }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--source' && i + 1 < args.length) { source = args[++i]; i++ }
    else if (arg === '--rationale' && i + 1 < args.length) { rationale = args[++i]; i++ }
    else if (arg === '--tags' && i + 1 < args.length) {
      tags = args[++i].split(',').map(t => t.trim()).filter(Boolean); i++
    }
    else if (arg === '--visibility' && i + 1 < args.length) {
      const v = args[++i]
      // Validate before writing: an unknown value would fail schema validation
      // on every later read, quarantining the engram (invisible to list and
      // recall) after a success message.
      const allowed = ['private', 'public', 'template']
      if (!allowed.includes(v)) {
        exit(1, `Unknown --visibility "${v}". One of: ${allowed.join(', ')}.`)
      }
      visibility = v as typeof visibility; i++
    }
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
    else if (arg === '--license' && i + 1 < args.length) {
      const v = value('--license', args[++i]).trim()
      // An empty or blank licence is a typo, not a choice. Accepting it would
      // write the schema default and report `chosen: false` to an operator who
      // did supply a value.
      if (!v) exit(1, '--license needs a licence identifier, for example cc-by-4.0.')
      license = v; i++
    }
    else if (arg === '--asserted-by' && i + 1 < args.length) {
      const v = value('--asserted-by', args[++i]).trim()
      if (!v) exit(1, '--asserted-by needs a name, for example local:maintainer.')
      assertedBy = v; i++
    }
    else if (arg === '--claim-class' && i + 1 < args.length) {
      const v = args[++i]
      const allowed = ['observed', 'documented', 'structural', 'asserted', 'inferred', 'revised']
      // Reject rather than drop. A silently ignored claim class is worse than
      // an error: the engram is written looking complete and is not.
      if (!allowed.includes(v)) {
        exit(1, `Unknown --claim-class "${v}". One of: ${allowed.join(', ')}.`)
      }
      claimClass = v as typeof claimClass; i++
    }
    // `--` ends flag parsing: the next token is the statement, verbatim, even
    // when it starts with `-`.
    else if (arg === '--') {
      if (!statement && i + 1 < args.length) statement = args[i + 1]
      break
    }
    else if (!statement) { statement = arg; i++ }
    else { i++ }
  }

  if (!statement && !process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    statement = Buffer.concat(chunks).toString('utf-8').trim()
  }

  if (!statement) {
    exit(1, 'Usage: plur learn <statement> [--scope <scope>] [--type <type>] [--domain <domain>] ' +
      '[--source <s>] [--rationale <r>] [--tags a,b,c] [--visibility private|public|template] ' +
      '[--abstract <id>] [--derived-from <id>] [--knowledge-anchors <json>] [--dual-coding <json>] ' +
      '[--supersedes id1,id2] [--license <spdx-id>] [--claim-class <kind>] [--asserted-by <who>]\n' +
      '       plur learn [flags] -- <statement>   (a statement that starts with "-")\n\n' +
      '  --license      which licence governs reuse of this memory, e.g. cc-by-4.0.\n' +
      '                 Leave it out and a default applies that nobody chose, and\n' +
      '                 a provenance record will say so.\n' +
      '  --claim-class  observed | documented | structural | asserted | inferred | revised.\n' +
      '                 Whether somebody stated this or a model worked it out.\n' +
      '  --asserted-by  who is answerable for it. Any address: a local name, a\n' +
      '                 Decentralized Identifier, or an identifier for a process.')
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
    ...(license !== undefined ? { license } : {}),
    ...(claimClass !== undefined ? { claim_class: claimClass } : {}),
    ...(assertedBy !== undefined ? { attribution: { asserted_by: assertedBy } } : {}),
    ...(scopeProvided ? { scope } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(abstract !== undefined ? { abstract } : {}),
    ...(derivedFrom !== undefined ? { derived_from: derivedFrom } : {}),
    ...(knowledgeAnchors !== undefined ? { knowledge_anchors: knowledgeAnchors } : {}),
    ...(dualCoding !== undefined ? { dual_coding: dualCoding } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    // A CLI invocation is a session too, so sources[].session_id is never null.
    // PLUR_SESSION_ID lets a wrapping harness thread its own id through;
    // otherwise the run identifies itself as a CLI run.
    session_id: process.env.PLUR_SESSION_ID || `cli:${process.pid}`,
  }

  // ALWAYS use learnRouted (not learn): learn() stamps _demoted but does NOT do
  // remote-outbox routing for shared scopes; only learnRouted() does — so an
  // explicit `--scope group:engineering` on learn() would silently drop the
  // remote push.
  //
  // The deadline lives in core and covers the server request only. Do not race
  // the whole call against a timer and exit: that would cut short local writes
  // into large stores, leave the store lock behind, and exit before core's
  // outbox fallback runs. A server that does not answer in time takes the
  // outbox; this awaits whatever core does. Exit 1 only when core throws.
  const engram = await plur.learnRouted(statement, ctx, { remoteTimeoutMs: REMOTE_WRITE_TIMEOUT_MS })

  // Where the engram went — remote, outbox or local. A shared scope that
  // stayed local also carries a warning, because nothing else would tell the
  // user their team save never left this machine.
  const delivered = plur.deliveryOf(engram, scopeProvided ? scope : undefined)
  // Report the id in the form the read paths hand back, as the MCP plur_learn
  // does. A server-minted id is bare and can collide with ids minted on this
  // machine the same day; the namespaced form (`ENG-GTE-…`) names the store. An
  // outbox row keeps its local id: it sits in the local store until the retry lands.
  const reportedId = delivered.delivery === 'outbox' ? engram.id : plur.readIdFor(engram)

  // Surface a scope demotion instead of swallowing it silently.
  // When learnRouted demotes a sensitive shared-scope write to local/private it
  // stamps structured_data._demoted; mirror the MCP display contract (tools.ts)
  // so the CLI user sees why the engram did not land at the requested scope.
  const demoted = (engram as { structured_data?: { _demoted?: { from: string; to: string; patterns: string } } })
    .structured_data?._demoted

  // Missing-domain nudge — mirrors the MCP domain_hint
  // contract in tools.ts. An engram without a `domain` cannot auto-route (the
  // domain-prefix channel is the only signal that reliably clears the
  // auto-route threshold). Fire only when routing was on the table: no
  // --domain, no --scope, the write did NOT auto-route, and at least one
  // registered scope declares covers. Advisory only — never fails the write.
  let domainHint: string | undefined
  const routed = (engram as { structured_data?: { _routed?: { scope: string; confidence: number; reason: string } } })
    .structured_data?._routed
  // Both routing outcomes are reported: each changes where the engram ended up,
  // which a write command must be able to say.
  const routeRefused = (engram as { structured_data?: { _routeRefused?: { scope: string; confidence: number; reason: string } } })
    .structured_data?._routeRefused
  if (!domain && !scopeProvided && !routed) {
    try {
      const coversScopes = plur.listScopeMetadata()
        .filter(md => (md.covers?.length ?? 0) > 0)
        .map(md => md.scope)
      if (coversScopes.length > 0) {
        domainHint =
          `No domain set — without a dotted domain this engram cannot auto-route to a covers-declaring scope ` +
          `(${coversScopes.join(', ')}). Pass --domain "<org>.<team>.<area>" (e.g. "plur.engineering.mcp").`
      }
    } catch { /* advisory only */ }
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      id: reportedId,
      statement: engram.statement,
      scope: engram.scope,
      type: engram.type,
      domain: engram.domain ?? null,
      delivery: delivered.delivery,
      destination: delivered.destination,
      ...(delivered.reason ? { delivery_reason: delivered.reason, delivery_reason_code: delivered.reason_code } : {}),
      ...(delivered.warning ? { delivery_warning: delivered.warning } : {}),
      // Include the demotion only when it happened; include requested_scope ONLY
      // when --scope was passed, to avoid a confusing requested_scope on an
      // unscoped write that demoted from the resolved default.
      ...(demoted
        ? { demoted: { from: demoted.from, to: demoted.to, patterns: demoted.patterns }, ...(scopeProvided ? { requested_scope: demoted.from } : {}) }
        : {}),
      ...(domainHint ? { domain_hint: domainHint } : {}),
      ...(routed ? { routed: { scope: routed.scope, confidence: routed.confidence, reason: routed.reason } } : {}),
      ...(routeRefused ? { route_refused: { scope: routeRefused.scope, confidence: routeRefused.confidence, reason: routeRefused.reason } } : {}),
    })
  } else {
    // Confirmation of a requested mutation → suppressed by --quiet.
    outputInfo(`Learned: "${engram.statement}"`, flags)
    outputInfo(`  ID: ${reportedId} | Scope: ${engram.scope} | Type: ${engram.type}${engram.domain ? ` | Domain: ${engram.domain}` : ''}`, flags)
    if (delivered.delivery === 'outbox') {
      // Not where a reader assumes a team save went — never suppressed.
      outputText(`  Queued in the outbox: ${delivered.reason ?? `saved on this machine and queued for ${engram.scope}.`}`)
    }
    if (delivered.destination.startsWith('saved on this laptop only —') || delivered.delivery === 'outbox') {
      outputText(`  Saved: ${delivered.destination}`)
    } else outputInfo(`  Saved: ${delivered.destination}`, flags)
    if (demoted) {
      // The write landed somewhere OTHER than requested — never suppressed.
      outputText(
        `  Warning: Sensitive content (${demoted.patterns}) detected — stored at ` +
        `${demoted.to}/private instead of ${demoted.from}; re-scope deliberately if false positive.`,
      )
    }
    if (delivered.warning) {
      // Same class as the demotion: the write is not where a reader of the
      // command would assume, so it is never suppressed by --quiet.
      outputText(`  Warning: ${delivered.warning}`)
    }
    if (routed) {
      // Where it landed, when the caller did not choose — same class as the
      // demotion above: the write is not where a reader of the command would
      // assume, so it is stated rather than hinted.
      outputText(
        `  Note: No scope was given — auto-routed to ${routed.scope} ` +
        `(confidence ${routed.confidence}) because its content matched that scope's covers. ` +
        `Pass --scope to choose deliberately.`,
      )
    }
    if (routeRefused) {
      outputText(
        `  Warning: No scope was given. This content matched the shared scope ${routeRefused.scope} ` +
        `(confidence ${routeRefused.confidence}), which unscoped writes are never auto-routed into — ` +
        `it was stored at ${engram.scope} instead. Pass --scope ${routeRefused.scope} if it belongs to ` +
        `the team, or move it with plur rescope.`,
      )
    }
    if (domainHint) {
      outputInfo(`  Hint: ${domainHint}`, flags)
    }
  }
}
