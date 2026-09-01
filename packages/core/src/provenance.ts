/**
 * Build a provenance record for an engram (#964).
 *
 * A record answers, for one engram: what produced it, what it came from, who is
 * answerable, when, and under what terms it may be reused. It is written as
 * JSON-LD using the W3C PROV vocabulary, so software that has never heard of us
 * can read it.
 *
 * Specification: `spec/ENGRAM-PROVENANCE-PROFILE.md`.
 * Worked examples, checked against two outside tools: `spec/examples/`.
 *
 * Three rules this file exists to enforce.
 *
 * **It is a view, not a store.** The record is built from the engram plus the
 * history log, on demand. Nothing new becomes a source of truth. If the record
 * and the stores disagree, the stores win. See ADR-0002.
 *
 * **A record you send must stand on its own.** Whoever receives an engram has
 * none of our files, so a portable record carries everything it depends on and
 * refers to nothing outside itself.
 *
 * **Never invent an agent.** Where the actor is unknown, the relationship is
 * omitted. A record with no agent is valid and honest. A record with a guessed
 * agent is worse than one with none, because it looks like evidence.
 */
import type { Engram } from './schemas/engram.js'
import type { HistoryEvent } from './history.js'

const PROV = 'http://www.w3.org/ns/prov#'
const ENGRAM_NS = 'https://plur.ai/ns/engram#'

/** Prefixes every record declares, so each name says which vocabulary it is from. */
const CONTEXT: Record<string, string> = {
  prov: PROV,
  engram: ENGRAM_NS,
  pa: 'https://w3id.org/prov-agent#',
  odrl: 'http://www.w3.org/ns/odrl/2/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
}

/**
 * Which history event becomes which kind of activity.
 *
 * This vocabulary was not invented. It was already there, in the list of event
 * types the code writes. Events absent from this map produce no activity —
 * including the four that are declared but never emitted.
 */
const ACTIVITY_OF: Record<string, string> = {
  engram_created: 'engram:Learn',
  engram_updated: 'engram:Revise',
  engram_merged: 'engram:Consolidate',
  engram_promoted: 'engram:Promote',
  procedure_evolved: 'engram:Revise',
  engram_retired: 'engram:Retire',
  engram_decremented: 'engram:Dereference',
  recurrence_detected: 'engram:Recur',
  contradiction_detected: 'engram:DetectTension',
  feedback_received: 'engram:Feedback',
  co_injection: 'engram:Inject',
  injection_outcome: 'engram:Outcome',
}

/**
 * Licence names mapped to what they permit, require and forbid.
 *
 * The licence text is authoritative; this is a machine-readable summary of it.
 * If the two ever disagree, the licence wins — which is why every policy also
 * carries the canonical licence address.
 *
 * An unrecognised licence produces a policy granting NOTHING, with
 * `engram:licenseRecognised: false` — never a permissive default, and never no
 * policy at all. See `licencePolicy` for why the no-policy version was wrong.
 */
const LICENCE_POLICY: Record<string, { uid?: string; permit: string[]; require: string[]; forbid: string[]; note?: string }> = {
  'cc-by-4.0': {
    uid: 'https://creativecommons.org/licenses/by/4.0/',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: [],
  },
  'cc-by-sa-4.0': {
    uid: 'https://creativecommons.org/licenses/by-sa/4.0/',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute', 'shareAlike'], forbid: [],
  },
  'cc-by-nc-4.0': {
    uid: 'https://creativecommons.org/licenses/by-nc/4.0/',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: ['commercialize'],
  },
  'cc-by-nd-4.0': {
    uid: 'https://creativecommons.org/licenses/by-nd/4.0/',
    permit: ['use', 'reproduce', 'distribute'], require: ['attribute'], forbid: ['derive'],
  },
  'cc0-1.0': {
    uid: 'https://creativecommons.org/publicdomain/zero/1.0/',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: [], forbid: [],
  },
  'apache-2.0': {
    uid: 'https://www.apache.org/licenses/LICENSE-2.0',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: [],
  },
  mit: {
    uid: 'https://opensource.org/license/mit',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: [],
  },
  'gpl-3.0': {
    uid: 'https://www.gnu.org/licenses/gpl-3.0.html',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute', 'shareAlike'], forbid: [],
  },
  'bsd-3-clause': {
    uid: 'https://opensource.org/license/bsd-3-clause',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: [],
  },
  'bsd-2-clause': {
    uid: 'https://opensource.org/license/bsd-2-clause',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: [],
  },
  isc: {
    uid: 'https://opensource.org/license/isc-license-txt',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute'], forbid: [],
  },
  'mpl-2.0': {
    uid: 'https://www.mozilla.org/en-US/MPL/2.0/',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute', 'shareAlike'], forbid: [],
  },
  'agpl-3.0': {
    uid: 'https://www.gnu.org/licenses/agpl-3.0.html',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute', 'shareAlike'], forbid: [],
  },
  'lgpl-3.0': {
    uid: 'https://www.gnu.org/licenses/lgpl-3.0.html',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: ['attribute', 'shareAlike'], forbid: [],
  },
  unlicense: {
    uid: 'https://unlicense.org/',
    permit: ['use', 'reproduce', 'distribute', 'derive'], require: [], forbid: [],
  },
  'cc-by-nc-sa-4.0': {
    uid: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    permit: ['use', 'reproduce', 'distribute', 'derive'],
    require: ['attribute', 'shareAlike'], forbid: ['commercialize'],
  },
  // Not a licence, and that is the point: it is the recorded ABSENCE of a grant.
  //
  // It has to be here rather than in the unrecognised branch. "proprietary" is a
  // deliberate statement by whoever wrote the engram, and reporting it as "not a
  // licence this software knows" tells the reader we failed to look it up, when
  // in fact we understood it perfectly and the answer is no. The two produce the
  // same permissions and opposite impressions, and the reader acts on the
  // impression.
  //
  // No `uid`: there is no canonical address to follow, which is itself the
  // distinguishing feature — with any other licence a reader can go and read the
  // terms, and here there are none to read. They have to ask a person.
  proprietary: {
    permit: [], require: [],
    forbid: ['use', 'reproduce', 'distribute', 'derive', 'commercialize'],
    note: 'The holder grants nothing here. This is not an unknown licence — it is a '
      + 'recorded decision to withhold permission. Any reuse needs the holder\'s '
      + 'agreement, obtained directly. There is no licence text to consult.',
  },
  // Same reasoning as `proprietary`, and it must be here for a sharper reason:
  // `unlicense` sits eleven lines above and means the OPPOSITE.
  //
  // The Unlicense is a public-domain dedication that grants everything.
  // "unlicensed" is the recorded absence of a grant, and it is the spelling four
  // user-facing surfaces tell an operator to type when they want to grant
  // nothing — packs.ts, the CLI, the MCP tool and the profile §5.4. With no
  // entry here it fell through to the unrecognised branch, which reports
  // `licenceRecognised: false` and advises the reader to go and read a licence
  // text that does not exist. The permissions came out right by luck; the
  // impression came out exactly backwards, and the reader acts on the
  // impression.
  //
  // A dropped 'd' between these two keys is the difference between "I grant
  // nothing" and "I dedicate this to the public domain". Keeping both spellings
  // present and opposite is what makes that a typo the record can survive.
  unlicensed: {
    permit: [], require: [],
    forbid: ['use', 'reproduce', 'distribute', 'derive', 'commercialize'],
    note: 'No licence was granted. This is a recorded decision, not a lookup that '
      + 'failed — do not confuse it with `unlicense`, the public-domain '
      + 'dedication, which grants everything. Any reuse needs the holder\'s '
      + 'agreement, obtained directly. There is no licence text to consult.',
  },
}

/**
 * Extra fields for a particular field of work (#973).
 *
 * Later we will record provenance for medical data, land registries, supply
 * chains. Each has facts worth recording that mean nothing to the others. The
 * standard already allows this, and so does our own: unknown fields survive a
 * round trip untouched.
 *
 * Four rules keep it safe, and `assertDomainFields` enforces the first two:
 *
 *   1. A domain adds fields under ITS OWN prefix, never `prov:` or `engram:`.
 *   2. A domain never redefines an existing term to mean something else.
 *   3. A reader keeps fields it does not recognise, and does not fail on them.
 *   4. A reader does not treat an unrecognised field as trustworthy.
 */
export interface DomainExtension {
  /** Prefixes this domain declares, e.g. `{ geo: 'https://example.org/geo#' }`. */
  namespaces: Record<string, string>
  /** Attributes to add to the engram, e.g. `{ 'geo:parcelId': '1234' }`. */
  attributes: Record<string, unknown>
}

const RESERVED_PREFIXES = new Set(['prov', 'engram', 'pa', 'odrl', 'xsd'])

/**
 * Refuse a domain extension that would collide with the core vocabulary.
 *
 * Throwing is deliberate. A silently dropped field looks like it was recorded,
 * and a silently overwritten core term corrupts every reader downstream.
 */
export function assertDomainFields(extension: DomainExtension): void {
  for (const prefix of Object.keys(extension.namespaces)) {
    if (RESERVED_PREFIXES.has(prefix)) {
      throw new Error(
        `provenance: the prefix "${prefix}" belongs to the core vocabulary and cannot be redefined. ` +
        `Use your own prefix for domain-specific fields.`,
      )
    }
  }
  for (const key of Object.keys(extension.attributes)) {
    const prefix = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
    if (!prefix) {
      throw new Error(
        `provenance: the attribute "${key}" has no prefix. Every domain field needs one, ` +
        `so a reader can tell which vocabulary it belongs to.`,
      )
    }
    if (RESERVED_PREFIXES.has(prefix)) {
      throw new Error(
        `provenance: the attribute "${key}" uses the core prefix "${prefix}". ` +
        `A domain must not redefine a core term. Use your own prefix.`,
      )
    }
    if (!(prefix in extension.namespaces)) {
      throw new Error(
        `provenance: the attribute "${key}" uses the prefix "${prefix}", which is not declared. ` +
        `Add it to namespaces so a reader knows what it means.`,
      )
    }
  }
}

export interface ProvenanceOptions {
  /** Extra fields for a particular field of work (#973). */
  domain?: DomainExtension
  /**
   * `portable` produces a record that stands on its own, for sharing. It names
   * no other engram, carries no session identifier, and refers to nothing the
   * recipient cannot resolve.
   *
   * `local` may refer to our own identifiers, because the reader has our files.
   *
   * Default is `portable`, because that is the mode where a mistake does harm.
   */
  mode?: 'portable' | 'local'
  /** Include the engram's own text. Off by default: the origin can often be shared when the content cannot. */
  includeStatement?: boolean
  /** Fixed time, for tests. Defaults to now. */
  now?: string
  /**
   * The licence on the pack this engram is being exported inside, if any.
   *
   * A member with no licence of its own INHERITS the pack's, and the record
   * says so rather than presenting it as the engram's own choice. Two reasons
   * this is inheritance and not application. A pack licence is granted by
   * whoever assembled the pack, who may not hold rights over every engram in
   * it — one may quote somebody else's documentation. And a reader deciding
   * whether to trust a grant needs to know who made it.
   */
  packLicense?: string
  /**
   * Identity of that pack, as `<name>@<version>`.
   *
   * Required for inheritance to mean anything. "This licence came from a pack"
   * without naming the pack is a dangling claim — and in a PORTABLE record it
   * is the worst kind, because the recipient has none of our files and cannot
   * go and look. Naming it lets them see who granted the licence they are
   * being asked to rely on.
   */
  packId?: string
  /**
   * A licence the user configured as their default (`provenance.default_license`).
   *
   * Used when neither the engram nor the pack names one. Distinct from the
   * schema default, because somebody actually chose this.
   */
  configuredLicense?: string
}

/**
 * Where an engram's effective licence came from.
 *
 * This replaced a boolean, which could only say "default or not" and so
 * collapsed three genuinely different situations. The one that mattered: a
 * licence the user configured once, deliberately, was being reported the same
 * way as the schema's `cc-by-sa-4.0` that nobody has ever looked at.
 */
export type LicenseSource = 'chosen' | 'inheritedFromPack' | 'configuredDefault' | 'schemaDefault'

/** Was this licence the result of somebody deciding? */
const wasDecided = (source: LicenseSource) => source === 'chosen' || source === 'configuredDefault'

const LICENSE_SOURCE_NOTE: Record<LicenseSource, string | undefined> = {
  chosen: undefined,
  inheritedFromPack:
    'This licence is the pack\'s, not this memory\'s. Whoever assembled the pack granted '
    + 'it; nobody recorded a licence for this memory itself, and the assembler may not hold '
    + 'rights over its content.',
  configuredDefault:
    'Nobody picked this licence for this memory. It is the default its author configured, '
    + 'so it was chosen once rather than chosen here.',
  schemaDefault:
    'Nobody chose this licence at any point. It is the schema default, and it is the only '
    + 'value in this record that was not recorded by somebody.',
}

type Node = Record<string, unknown>

const instant = (iso: string) => ({ '@value': iso, '@type': 'xsd:dateTime' })

/** When the engram was first written. `temporal.learned_at` is absent on ordinary engrams. */
function bornAt(engram: Engram): string | undefined {
  const t = (engram as any).temporal?.learned_at
  if (typeof t === 'string') return t
  const sources = (engram as any).sources as Array<{ stored_at?: string }> | undefined
  const stamps = (sources ?? []).map(s => s?.stored_at).filter((x): x is string => typeof x === 'string')
  return stamps.length ? stamps.sort()[0] : undefined
}

/**
 * The licence as a machine-readable policy.
 *
 * `withheld` means the engram is private or local: it has not been cleared to
 * leave this machine. The licence still describes what a recipient could do
 * with the CONTENT, but nobody may pass the memory on, so the policy has to say
 * so outright.
 *
 * This existed as a sentence in the readable summary and was missing from the
 * record. A tester read the record — the format sold as the machine-readable
 * one — and found `odrl:distribute` permitted with no prohibition anywhere,
 * beside `engram:visibility: private`. Software reading only the policy would
 * have concluded that distributing a private memory was allowed. The two
 * outputs must not disagree, and where they do, the machine-readable one is the
 * dangerous one to leave wrong.
 */
function licencePolicy(name: string | undefined, withheld = false): Node | undefined {
  if (!name) return undefined
  const spec = LICENCE_POLICY[name.trim().toLowerCase()]
  if (!spec) {
    // A licence we do not recognise gets a policy that GRANTS NOTHING, rather
    // than no policy at all.
    //
    // Emitting nothing was the original design, on the reasoning that a guess
    // is worse than silence. It is — but silence is not what a reader receives.
    // A tester pointed out the consequence: software checking policies saw a
    // prohibition on an MIT memory and none whatsoever on one marked
    // `proprietary`, so the proprietary one looked the LESS restricted of the
    // two. Absence was being read as permission, exactly backwards.
    //
    // So: no permissions, an explicit note, and the licence name to go and read.
    // Still no guess — the difference is that the reader is now told there is
    // nothing here to rely on, instead of inferring it from a missing key.
    return {
      '@type': 'odrl:Set',
      'odrl:permission': [],
      'engram:licenseRecognised': false,
      'engram:note':
        `"${bidiIsolate(name)}" is not a licence this software knows. No permission is expressed here. `
        + 'Read the licence itself before reusing anything under it. An empty permission '
        + 'list means nothing was determined, NOT that everything is allowed.',
    }
  }
  // A licence that grants nothing carries an EMPTY permission list, not a
  // permission naming no actions. `{ "odrl:action": [] }` is a permission that
  // permits nothing, which a reader has to inspect to understand; no permission
  // at all is the plain statement.
  const permission: Node = { 'odrl:action': spec.permit.map(a => `odrl:${a}`) }
  if (spec.require.length) permission['odrl:duty'] = spec.require.map(a => ({ 'odrl:action': `odrl:${a}` }))
  const policy: Node = {
    '@type': 'odrl:Set',
    ...(spec.uid ? { 'odrl:uid': spec.uid } : {}),
    'odrl:permission': spec.permit.length ? [permission] : [],
  }
  // We DID recognise it. Said explicitly, because an empty permission list is
  // also what an unrecognised licence produces, and the two mean opposite
  // things: "the answer is no" against "we could not tell".
  policy['engram:licenseRecognised'] = true
  if (spec.note) policy['engram:note'] = spec.note

  const forbid = spec.forbid.map(a => ({ 'odrl:action': `odrl:${a}` } as Node))
  if (withheld) {
    // Named so a reader who understands nothing else about our vocabulary can
    // still see WHY it is forbidden, and that it is not the licence's doing.
    forbid.push({
      'odrl:action': 'odrl:distribute',
      'engram:reason': 'notShared',
      'engram:note':
        'This memory is private or local. It has not been cleared to leave this '
        + 'machine. The permissions above describe the licence on the content, '
        + 'not permission to pass the memory on.',
    })
  }
  if (forbid.length) policy['odrl:prohibition'] = forbid
  return policy
}

/**
 * Turn a name for somebody into a valid identifier in the record.
 *
 * Two cases, and getting either wrong is a real defect a tester found.
 *
 * A value that is ALREADY a web-style address — a Decentralized Identifier
 * (`did:`), a web address, or a `urn:` — is one in its own right. Prefixing it
 * produced `engram:agent/did:example:alice`, which is a different, meaningless
 * identifier and loses the property that made a Decentralized Identifier worth
 * accepting.
 *
 * Anything else becomes a local name under our own prefix, with characters an
 * identifier may not contain escaped. `engram:agent/Platform Lead` carries a raw
 * space, which is not a legal identifier at all; a strict reader is entitled to
 * reject the whole document over it.
 */
function agentId(name: string): string {
  // Normalise first. The same name typed on two machines can arrive in two
  // different encodings of identical text — accented characters have a composed
  // and a decomposed form — and without this one colleague becomes two separate
  // agents in the graph, indistinguishable in every readable view.
  const normal = name.normalize('NFC')
  return /^(did:|https?:|urn:|ipns:|ipfs:)/i.test(normal) ? normal : `engram:agent/${escapeIri(normal)}`
}

/**
 * Escape only what an identifier genuinely may not contain.
 *
 * Percent-encoding everything is wrong here. A colon is perfectly legal after
 * the first segment, and `local:maintainer` is the ordinary way people name themselves
 * in this system — turning it into `local%3Acrt` changes the identifier and
 * makes it unreadable for no gain. What actually breaks a parser is a space,
 * a control character, and the delimiters below.
 */
function escapeIri(value: string): string {
  // Also the invisible ones. A zero-width joiner or a direction override sitting
  // raw inside an identifier is worse than a space: it cannot be seen, it makes
  // two identifiers that look identical compare unequal, and a direction mark
  // can reorder how the surrounding text is displayed.
  // eslint-disable-next-line no-control-regex
  return value.replace(
    /[\u0000-\u0020<>"{}|\\^`\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

/**
 * Wrap a value so it cannot reorder the sentence around it.
 *
 * A line that begins with an interpolated value takes its direction from that
 * value. An Arabic licence name at the start of an English sentence flipped the
 * whole line: the full stop moved to the front and the indentation jumped to
 * the right edge. The reader sees a sentence that was never written.
 *
 * The isolate characters say "treat this run as its own direction" and are
 * invisible. They are added only when the value actually contains
 * right-to-left text, so ordinary output is unchanged byte for byte.
 */
function bidiIsolate(value: string): string {
  // Hebrew, Arabic, Syriac, Thaana, and the Arabic presentation blocks.
  if (!/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/.test(value)) return value
  return `\u2068${value}\u2069`
}

/** Turn an escaped identifier segment back into the text a person typed. */
function readableAgent(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Build the agent nodes, and the relationships that point at them. */
function agentNodes(engram: Engram): {
  nodes: Node[]; attributedTo?: string; associatedWith?: string
  usedModel?: string; onBehalfOf?: string
} {
  const a = (engram as any).attribution as Engram['attribution']
  if (!a) return { nodes: [] }
  const nodes: Node[] = []
  let attributedTo: string | undefined
  let associatedWith: string | undefined
  let usedModel: string | undefined
  let onBehalfOf: string | undefined

  if (a.asserted_by) {
    attributedTo = agentId(a.asserted_by)
    const node: Node = { '@id': attributedTo, '@type': 'prov:Agent' }
    // Say plainly that nobody was identified, rather than leaving it ambiguous.
    if (a.asserted_by === 'unidentified') {
      node['engram:identityKnown'] = false
      node['engram:note'] = 'No identity was configured when this was written.'
    }
    nodes.push(node)
  }

  // The runtime and the tool are DIFFERENT things and both are recorded when
  // both are given. `runtime ?? tool` dropped the tool whenever a runtime was
  // present, and when only a tool was given it was written into the runtime
  // slot and typed as an AI agent — so an import script was recorded as one.
  const softwareId = (name: string, version?: string) =>
    `engram:agent/software/${escapeIri(name)}${version ? `@${escapeIri(version)}` : ''}`

  if (a.runtime) {
    associatedWith = softwareId(a.runtime.name, a.runtime.version)
    const node: Node = {
      '@id': associatedWith,
      '@type': ['prov:SoftwareAgent', 'pa:AIAgent'],
      'engram:runtimeName': a.runtime.name,
    }
    if (a.runtime.version) node['engram:runtimeVersion'] = a.runtime.version
    // ONLY when somebody said so. This used to fall back to `asserted_by`,
    // which invented a delegation nobody recorded and put it in a document
    // whose footer promises that nothing is guessed.
    if (a.on_behalf_of) node['prov:actedOnBehalfOf'] = { '@id': agentId(a.on_behalf_of) }
    nodes.push(node)
  }

  if (a.tool) {
    const id = softwareId(a.tool.name, a.tool.version)
    // A tool is not an AI agent. PROV-AGENT has a term for exactly this.
    const node: Node = { '@id': id, '@type': ['prov:SoftwareAgent', 'pa:AgentTool'], 'engram:toolName': a.tool.name }
    if (a.tool.version) node['engram:toolVersion'] = a.tool.version
    if (a.on_behalf_of) node['prov:actedOnBehalfOf'] = { '@id': agentId(a.on_behalf_of) }
    nodes.push(node)
    // If there is no runtime, the tool is what the engram was produced with.
    if (!associatedWith) associatedWith = id
  }

  // Somebody can act on another's behalf without any software being named.
  // This lived inside the runtime branch, so an attribution carrying only
  // `on_behalf_of` recorded it nowhere — the value was in storage and appeared
  // on no surface at all, the record included.
  if (a.on_behalf_of && !a.runtime && !a.tool) {
    nodes.push({ '@id': agentId(a.on_behalf_of), '@type': 'prov:Agent' })
    onBehalfOf = agentId(a.on_behalf_of)
  } else if (a.on_behalf_of) {
    onBehalfOf = agentId(a.on_behalf_of)
  }

  if (a.model) {
    const id = `engram:model/${escapeIri(a.model.name)}`
    const node: Node = { '@id': id, '@type': ['prov:SoftwareAgent', 'pa:AIModel'], 'engram:modelName': a.model.name }
    // The prompt is identified by hash. Its text is never stored.
    if (a.model.prompt_sha256) node['engram:promptHash'] = `sha256:${a.model.prompt_sha256}`
    if (a.model.prompt_id) node['engram:promptId'] = a.model.prompt_id
    if (a.model.prompt_version) node['engram:promptVersion'] = a.model.prompt_version
    nodes.push(node)
    usedModel = id
  }

  return { nodes, attributedTo, associatedWith, usedModel, onBehalfOf }
}

/**
 * Build a provenance record for one engram.
 *
 * `events` are the history entries mentioning this engram. Pass an empty array
 * to describe the engram alone.
 */
export function buildProvenanceRecord(
  engram: Engram,
  events: HistoryEvent[] = [],
  options: ProvenanceOptions = {},
): Node {
  const { mode = 'portable', includeStatement = false, now = new Date().toISOString(), domain } = options
  const portable = mode === 'portable'
  if (domain) assertDomainFields(domain)
  const id = engram.id
  const graph: Node[] = []

  // --- the record describes itself -------------------------------------
  //
  // A flat top-level "@graph" is deliberate. Putting "@id"/"@type" beside
  // "@graph" turns the contents into a NAMED graph, and an ordinary parse then
  // sees only the wrapper. We hit exactly that while writing the worked
  // examples: a document that looked correct produced 3 statements instead of 64.
  const bundle: Node = {
    '@id': `engram:record/${id}`,
    '@type': ['prov:Bundle', 'prov:Entity'],
    'prov:generatedAtTime': instant(now),
    'engram:describes': { '@id': `engram:${id}` },
    'engram:recordIsSelfContained': portable,
  }
  // How much history this record covers, required by the profile's section 9.
  //
  // Without it a reader cannot tell a record built from a full log from one
  // built from a log that had been rotated, truncated, or was simply not
  // consulted — and those produce the same document. "No retirement recorded"
  // then reads as "not retired", when it may only mean "we did not look that
  // far back". The value is the month of the newest event the record was built
  // from, matching the `history/YYYY-MM.jsonl` files it comes out of.
  //
  // Omitted, not faked, when no events were supplied: `engram:historyEvents: 0`
  // says the record describes the engram alone, which is a different claim from
  // covering a period and finding nothing in it.
  const stamps = events.map(e => e.timestamp).filter(t => typeof t === 'string').sort()
  bundle['engram:historyEvents'] = events.length
  if (stamps.length) bundle['engram:historyThrough'] = stamps[stamps.length - 1].slice(0, 7)
  graph.push(bundle)

  // --- the engram -------------------------------------------------------
  const agents = agentNodes(engram)
  const thing: Node = {
    '@id': `engram:${id}`,
    '@type': ['prov:Entity', 'engram:Engram'],
    'engram:engramType': engram.type,
    'engram:scope': engram.scope,
    'engram:status': engram.status,
  }
  if ((engram as any).commitment) thing['engram:commitment'] = (engram as any).commitment
  if ((engram as any).visibility) thing['engram:visibility'] = (engram as any).visibility
  if ((engram as any).content_hash) thing['engram:contentHash'] = `sha256:${(engram as any).content_hash}`
  if ((engram as any).claim_class) thing['engram:claimClass'] = (engram as any).claim_class
  const born = bornAt(engram)
  if (born) thing['prov:generatedAtTime'] = instant(born)
  if (includeStatement) thing['prov:value'] = engram.statement
  if (engram.tags?.length) thing['engram:tags'] = engram.tags

  const validUntil = (engram as any).temporal?.valid_until
  if (validUntil) thing['engram:validUntil'] = validUntil

  // A web address in `source` is a real external source. Anything else is a note.
  const source = (engram as any).source as string | undefined
  if (source?.startsWith('http')) thing['prov:hadPrimarySource'] = { '@id': source }
  else if (source) thing['engram:sourceNote'] = source

  // A licence nobody chose is not the same as a licence someone chose. The
  // effective licence applies either way, but the record must not present an
  // unchosen value as a recorded decision — and there are four ways to arrive
  // at one, not two.
  const chosenLicence = (engram as any).provenance?.license as string | undefined
  const licenceSource: LicenseSource =
    chosenLicence ? 'chosen'
    : options.packLicense ? 'inheritedFromPack'
    : options.configuredLicense ? 'configuredDefault'
    : 'schemaDefault'
  const licence = chosenLicence ?? options.packLicense ?? options.configuredLicense ?? 'cc-by-sa-4.0'
  // Private or local means it has not been cleared to leave this machine, and
  // the policy must forbid passing it on regardless of what the licence allows.
  const withheld = (engram as any).visibility === 'private' || (engram as any).scope === 'local'
  const policy = licencePolicy(licence, withheld)
  thing['engram:license'] = licence
  thing['engram:licenseSource'] = licenceSource
  // Kept alongside the four-state field: a reader that only understands
  // "was this decided or not" still gets a correct answer without having to
  // learn the vocabulary. It is the same question, asked more coarsely.
  if (!wasDecided(licenceSource)) thing['engram:licenseIsDefault'] = true
  const sourceNote = LICENSE_SOURCE_NOTE[licenceSource]
  if (sourceNote) thing['engram:licenseSourceNote'] = sourceNote

  // Name the pack this engram travelled inside, and — when the licence came
  // from it — say so as a link rather than only as a word.
  //
  // A stranger holding one of these files has none of our other files. So the
  // pack gets a stub node here too, carrying its licence and its own policy:
  // the record then answers "who granted this, and on what terms" without
  // needing the pack record beside it. That is the standing-on-its-own rule
  // (section 2.2) applied to the licence chain specifically.
  if (options.packId) {
    const packNodeId = `engram:pack/${options.packId}`
    thing['engram:memberOf'] = { '@id': packNodeId }
    if (licenceSource === 'inheritedFromPack') {
      thing['engram:licenseInheritedFrom'] = { '@id': packNodeId }
    }
    const packStub: Node = {
      '@id': packNodeId,
      '@type': ['prov:Entity', 'prov:Collection', 'engram:Pack'],
      'prov:hadMember': { '@id': `engram:${id}` },
    }
    if (options.packLicense) {
      packStub['engram:license'] = options.packLicense
      const packPolicy = licencePolicy(options.packLicense)
      if (packPolicy) packStub['odrl:hasPolicy'] = packPolicy
    }
    graph.push(packStub)
  }
  // One field a machine can read without understanding the policy at all.
  thing['engram:maySharePlainly'] = !withheld
  if (policy) thing['odrl:hasPolicy'] = policy

  if (agents.attributedTo) thing['prov:wasAttributedTo'] = { '@id': agents.attributedTo }
  // Point at the model, so the node is reachable. It was being written into the
  // graph with nothing linking to it, so no reader could connect a memory to
  // the model that produced it — in a record whose whole purpose includes
  // saying whether a model worked something out.
  if (agents.usedModel) thing['engram:usedModel'] = { '@id': agents.usedModel }

  const derivedFrom = (engram as any).derived_from as string | null | undefined
  if (derivedFrom) thing['prov:wasDerivedFrom'] = { '@id': `engram:${derivedFrom}` }

  // The engram this one REPLACED. Standard PROV has a term for it.
  const supersedes = (engram as any).relations?.supersedes as string[] | undefined

  // And the engram that replaced THIS one. PROV has no reverse of a revision,
  // so this is our own term — but it has to be recorded, because it is the
  // question a reader of the old memory is actually asking. Without it, asking
  // about a memory that was corrected five minutes ago returns a confident
  // answer with no hint that anybody has since disagreed.
  const supersededBy = (engram as any).relations?.superseded_by as string[] | undefined
  if (supersededBy?.length) {
    thing['engram:supersededBy'] = supersededBy.map(s => ({ '@id': `engram:${s}` }))
  }

  if (supersedes?.length) {
    thing['prov:wasRevisionOf'] = supersedes.map(s => ({ '@id': `engram:${s}` }))
  }
  graph.push(thing)

  // --- activities, from the history log ---------------------------------
  for (const ev of events) {
    const cls = ACTIVITY_OF[ev.event]
    if (!cls) continue
    const isInjection = ev.event === 'co_injection'
    const actId = isInjection
      ? `engram:act/${ev.engram_id}`
      : `engram:act/${id}-${ev.event}`
    const act: Node = {
      '@id': actId,
      '@type': ['prov:Activity', cls],
      'prov:startedAtTime': instant(ev.timestamp),
      'prov:endedAtTime': instant(ev.timestamp),
    }
    if (ev.event === 'engram_created') act['prov:generated'] = { '@id': `engram:${id}` }
    if (ev.event === 'engram_retired') {
      thing['prov:wasInvalidatedBy'] = { '@id': actId }
      thing['prov:invalidatedAtTime'] = instant(ev.timestamp)
    }
    if (ev.reason) act['engram:reason'] = ev.reason
    else if (typeof ev.data?.reason === 'string') act['engram:reason'] = ev.data.reason

    if (isInjection) {
      // A portable record names ONLY the engram it is about.
      //
      // The log lists every engram injected together. Copying that list would
      // tell the recipient the identifiers of other memories the sender holds.
      // Found while building the worked examples, where a record for one engram
      // would have disclosed five others.
      const ids = (ev.data?.ids as string[] | undefined) ?? []
      act['prov:used'] = portable
        ? { '@id': `engram:${id}` }
        : ids.map(i => ({ '@id': `engram:${i}` }))
      act['engram:usedAlongsideCount'] = Math.max(0, ids.length - 1)
      if (typeof ev.data?.query_hash === 'string') act['engram:queryHash'] = ev.data.query_hash
      // A session identifier means nothing to a recipient and reveals our internals.
      if (!portable && typeof ev.data?.session_id === 'string') {
        act['engram:session'] = `engram:session/${ev.data.session_id}`
      }
    }

    // Who caused THIS event, in preference to who asserted the engram.
    //
    // These are different questions and the record was answering the wrong one.
    // Every activity took the engram's attribution, so a memory asserted by one
    // person and retired by another showed the retirement associated with the
    // asserter — the correction attributed to the person it corrected. An
    // outside reviewer warned about exactly this collapse on the epic: a
    // correction needs both what it replaces and who made it, and merging them
    // loses the ability to answer either.
    //
    // Falls back to the engram's attribution only when the event carries no
    // actor, which is every event written before this field was populated.
    const eventAgents = ev.actor ? agentNodes({ attribution: ev.actor } as unknown as Engram) : undefined
    const associated = eventAgents?.associatedWith ?? agents.associatedWith
    if (associated) act['prov:wasAssociatedWith'] = { '@id': associated }
    if (eventAgents?.attributedTo) {
      // Say who was answerable for the event itself, distinct from
      // `prov:wasAttributedTo` on the engram.
      act['engram:causedBy'] = { '@id': eventAgents.attributedTo }
    }
    // Nodes for agents that appear only in the log, so nothing dangles.
    if (eventAgents?.nodes.length) {
      for (const node of eventAgents.nodes) {
        if (!graph.some(n => n['@id'] === node['@id'])) graph.push(node)
      }
    }
    graph.push(act)
  }

  // Domain fields go on the engram, under their own prefix (#973).
  if (domain) Object.assign(thing, domain.attributes)

  graph.push(...agents.nodes)
  const context = domain ? { ...CONTEXT, ...domain.namespaces } : CONTEXT
  return { '@context': context, '@graph': graph }
}

/** Serialize a record as JSON-LD text. */
export function serializeProvenanceRecord(record: Node, pretty = true): string {
  return JSON.stringify(record, null, pretty ? 2 : 0) + (pretty ? '\n' : '')
}


// --- Packs -----------------------------------------------------------------

export interface PackProvenanceInput {
  name: string
  version: string
  creator?: string
  /**
   * The licence in the pack's own manifest, governing the pack as a collection.
   *
   * Distinct from the licences on the engrams inside it, and the distinction is
   * not academic. A single engram is one short assertion; a pack is a curated
   * collection, and a collection is the thing that attracts rights in its own
   * right — the selection and arrangement, and in the European Union the sui
   * generis database right. So this is the licence a recipient of a pack most
   * needs, and it was the one field the record did not carry.
   */
  license?: string
  /** The pack's integrity hash, as written to its INTEGRITY file. */
  integrity?: string
  /** When the pack was assembled. Defaults to now. */
  assembledAt?: string
}

/**
 * Build a provenance record for a whole pack (#972).
 *
 * A pack is how engrams leave one machine and reach another, so this is where
 * provenance stops being a nicety. The recipient has our engrams and none of our
 * history, so this record stands entirely on its own.
 *
 * It answers a question no single engram can: **is this pack worth anything?**
 *
 * Who assembled it, when, out of what — and, from the engrams inside it, how
 * many were stated by a person versus inferred by a model, what dates they span,
 * and whether every engram carries a licence. Two packs of the same size are not
 * equal if one is direct statements from a named expert and the other is machine
 * guesses from an unknown source.
 *
 * On integrity: the pack's own hash covers `SKILL.md` and `engrams.yaml` only,
 * per the standard. A provenance file added to the pack is therefore NOT covered
 * by it. So the dependency runs the other way — this record carries the pack's
 * hash, and commits to the pack rather than the pack committing to it. Change
 * the pack and the hash in this record no longer matches.
 */
export function buildPackProvenanceRecord(
  pack: PackProvenanceInput,
  engrams: Engram[],
  options: ProvenanceOptions = {},
): Node {
  const { now = new Date().toISOString(), domain } = options
  if (domain) assertDomainFields(domain)

  const assembledAt = pack.assembledAt ?? now
  const packId = `engram:pack/${pack.name}@${pack.version}`
  const assemblyId = `engram:act/assemble-${pack.name}-${pack.version}`
  const graph: Node[] = []

  graph.push({
    '@id': `engram:record/pack/${pack.name}@${pack.version}`,
    '@type': ['prov:Bundle', 'prov:Entity'],
    'prov:generatedAtTime': instant(now),
    'engram:describes': { '@id': packId },
    'engram:recordIsSelfContained': true,
    // A pack record is built from the manifest and the members, never from the
    // history log — the log does not travel with a pack. Stated rather than left
    // out, so "no history here" is a fact about pack records and not a gap.
    'engram:historyEvents': 0,
  })

  // What a reader can judge before opening a single engram.
  const byClaim: Record<string, number> = {}
  const licences = new Set<string>()
  let licensed = 0
  let defaulted = 0
  const dates: string[] = []
  for (const e of engrams) {
    const claim = (e as any).claim_class ?? 'unstated'
    byClaim[claim] = (byClaim[claim] ?? 0) + 1
    const lic = (e as any).provenance?.license
    if (lic) { licences.add(lic); licensed++ }
    else defaulted++
    const born = bornAt(e)
    if (born) dates.push(born)
  }
  dates.sort()

  const packNode: Node = {
    '@id': packId,
    '@type': ['prov:Entity', 'prov:Collection', 'engram:Pack'],
    'engram:packName': pack.name,
    'engram:packVersion': pack.version,
    'prov:generatedAtTime': instant(assembledAt),
    'prov:wasGeneratedBy': { '@id': assemblyId },
    'prov:hadMember': engrams.map(e => ({ '@id': `engram:${e.id}` })),
    'engram:engramCount': engrams.length,
    // A quality signal, not a score. The reader weighs it themselves.
    'engram:claimClassCounts': byClaim,
    // Two counts, not one, and named for what they mean. "licensedCount" was
    // ambiguous and the ambiguity showed: it counted only engrams whose author
    // PICKED a licence, while every per-engram record in the same pack carries
    // a licence and a full grant — the default one. So a pack could report
    // "4 of 5 licensed" beside five files that each grant reuse. A reader has
    // to be able to tell how much of a pack somebody actually decided about.
    'engram:licenseChosenCount': licensed,
    'engram:licenseDefaultedCount': defaulted,
    // Chosen licences only. `engram:licenseDefaultedCount` above says how many
    // engrams carry the default instead, because listing the default here would
    // read as "somebody licensed this pack that way" when nobody did.
    'engram:licensesChosen': [...licences].sort(),
  }

  // The pack's OWN licence, which is a different question from the licences on
  // its members and the one a recipient of a pack asks first. It was recorded
  // nowhere: the record summarised what was inside and dropped the terms on the
  // collection itself.
  //
  // The two can disagree — an MIT-licensed pack of share-alike engrams is a
  // perfectly ordinary thing to build by accident. Neither overrides the other,
  // and the record must not pretend one does: the pack licence governs the
  // collection, each engram's licence governs its own content, and a reuser has
  // to satisfy both. Saying which is which is all a record can honestly do.
  if (pack.license) {
    packNode['engram:license'] = pack.license
    const packPolicy = licencePolicy(pack.license)
    if (packPolicy) packNode['odrl:hasPolicy'] = packPolicy
    const strictest = [...licences].filter(l => l !== pack.license)
    if (strictest.length || defaulted > 0) {
      packNode['engram:memberLicensesDiffer'] = true
      packNode['engram:note'] =
        'This licence covers the pack as a collection. The engrams inside carry '
        + 'their own licences, which are not all the same as this one, and a reuser '
        + 'has to satisfy both. Neither overrides the other.'
    }
  }
  if (dates.length) {
    packNode['engram:earliestEngram'] = dates[0]
    packNode['engram:latestEngram'] = dates[dates.length - 1]
  }
  if (pack.integrity) packNode['engram:packIntegrity'] = pack.integrity
  if (domain) Object.assign(packNode, domain.attributes)
  graph.push(packNode)

  const assembly: Node = {
    '@id': assemblyId,
    '@type': ['prov:Activity', 'engram:AssemblePack'],
    'prov:startedAtTime': instant(assembledAt),
    'prov:endedAtTime': instant(assembledAt),
    'prov:generated': { '@id': packId },
  }
  if (pack.creator) {
    const creatorId = agentId(pack.creator)
    assembly['prov:wasAssociatedWith'] = { '@id': creatorId }
    packNode['prov:wasAttributedTo'] = { '@id': creatorId }
    graph.push({ '@id': creatorId, '@type': 'prov:Agent' })
  }
  graph.push(assembly)

  // Every member is described here, so the record has no dangling reference.
  // Deliberately shallow: the per-engram records carry the detail.
  for (const e of engrams) {
    const member: Node = {
      '@id': `engram:${e.id}`,
      '@type': ['prov:Entity', 'engram:Engram'],
      'engram:engramType': e.type,
    }
    if ((e as any).claim_class) member['engram:claimClass'] = (e as any).claim_class
    if ((e as any).content_hash) member['engram:contentHash'] = `sha256:${(e as any).content_hash}`
    graph.push(member)
  }

  const context = domain ? { ...CONTEXT, ...domain.namespaces } : CONTEXT
  return { '@context': context, '@graph': graph }
}


// --- A summary a person can read -------------------------------------------

export interface ProvenanceSummary {
  engram_id: string
  /** True when this must not leave the machine. */
  private: boolean
  /**
   * The same answers as `lines`, but as data.
   *
   * `lines` are padded for a terminal. A consumer must never have to split
   * those on whitespace to recover a value — that is a text view wearing a
   * JSON wrapper, not machine-readable output.
   */
  fields: {
    says?: string
    scope?: string
    visibility?: string
    /**
     * May this memory LEAVE this machine at all? Derived from scope and
     * visibility, and nothing to do with the licence.
     *
     * It was called `shareable`, and a compliance tester read that as the
     * licence answer, which it is not: a private MIT memory reported
     * `shareable: false` although MIT permits commercial reuse, and a public
     * non-commercial one reported `true` although it forbids it. The name was
     * doing the misleading, so the name changed.
     */
    may_leave_this_machine: boolean
    /**
     * What the licence permits, as values a machine can act on rather than a
     * sentence it has to parse.
     *
     * These FAIL CLOSED. An unrecognised licence yields `false`, not `null`:
     * a tester observed that a consumer written as `if (x !== false)` reads
     * `null` as permission, and for a field that gates reuse, not knowing has
     * to mean no. `licence_recognised` carries the difference between "the
     * licence says no" and "we could not tell", so nothing is lost.
     */
    may_reuse_commercially: boolean
    may_redistribute: boolean
    licence_recognised: boolean
    /** Did somebody pick this licence, or is it the schema default? */
    licence_chosen: boolean
    asserted_by?: string
    /** An identity was supplied. NOT that anybody verified it. */
    identity_stated?: boolean
    written_by?: string
    revision_of?: string[]
    superseded_by?: string[]
    model?: string
    on_behalf_of?: string
    claim_class?: string
    claim_meaning?: string
    first_written?: string
    came_from?: { value: string; is_link: boolean }
    /** Engrams this one was derived from, when it was built out of others. */
    derived_from?: string[]
    licence?: { name: string; chosen: boolean; meaning?: string; source?: LicenseSource }
    recorded_steps?: number
    retired?: boolean
  }
  /** Plain-language lines, ready to print. */
  lines: string[]
  /** What could not be determined, named rather than left blank. */
  missing: string[]
  /** True when every one of the five questions has an answer. */
  complete: boolean
}

const CLAIM_MEANING: Record<string, string> = {
  observed: 'a record of something that happened',
  documented: 'taken from prose a human wrote',
  structural: 'read off the shape of a thing',
  asserted: 'someone stated it outright, rather than a model working it out',
  inferred: 'worked out by a model',
  revised: 'a rewrite of an earlier version',
}

const LICENCE_MEANING: Record<string, string> = {
  'cc-by-4.0': 'reuse allowed, credit required',
  'cc-by-sa-4.0': 'reuse allowed, credit required, share alike',
  'cc-by-nc-4.0': 'reuse allowed, credit required, NOT for commercial use',
  'cc-by-nd-4.0': 'reuse allowed, credit required, no derivatives',
  'cc0-1.0': 'no conditions',
  'apache-2.0': 'reuse allowed, credit required',
  mit: 'reuse allowed, credit required',
  'gpl-3.0': 'reuse allowed, credit required, share alike',
  'bsd-3-clause': 'reuse allowed, credit required',
  'bsd-2-clause': 'reuse allowed, credit required',
  isc: 'reuse allowed, credit required',
  'mpl-2.0': 'reuse allowed, credit required, share alike',
  'agpl-3.0': 'reuse allowed, credit required, share alike, including over a network',
  'lgpl-3.0': 'reuse allowed, credit required, share alike',
  unlicense: 'no conditions',
  'cc-by-nc-sa-4.0': 'reuse allowed, credit required, share alike, NOT for commercial use',
  proprietary: 'NO reuse granted — ask the holder',
  unlicensed: 'NO reuse granted — ask the holder (not the Unlicense)',
}

/**
 * Turn a record into something a person can read.
 *
 * A wall of JSON-LD is expensive for an agent to read and unreadable for a
 * human. The record is for machines; this is for whoever asked.
 *
 * It names what is MISSING as prominently as what is known. On an older engram
 * the honest answer is "nothing recorded who asserted this", and that is the
 * most useful thing this can say — hiding it would make the record look more
 * authoritative than it is.
 */
export function summariseProvenance(record: Node): ProvenanceSummary {
  const graph = (record['@graph'] as Node[]) ?? []
  const subject = graph.find(n => {
    const types = n['@type']
    return Array.isArray(types) && types.includes('engram:Engram')
  })
  const engramId = String(subject?.['@id'] ?? '').replace(/^engram:/, '')

  const lines: string[] = []
  const missing: string[] = []
  const fields: ProvenanceSummary['fields'] = {
    may_leave_this_machine: true,
    // Default to NO. An unanswered permission question must never read as yes.
    may_reuse_commercially: false,
    may_redistribute: false,
    licence_recognised: false,
    licence_chosen: false,
  }

  // What the memory SAYS, when the record carries it. Without this a reader
  // cannot tell whether a fuzzy search picked the right memory at all.
  const statement = subject?.['prov:value']
  if (statement) {
    fields.says = String(statement)
    lines.push(`Says          ${String(statement).slice(0, 90)}`)
  }

  // Sharing first, because it is the question with a wrong answer.
  const scope = subject?.['engram:scope'] as string | undefined
  const visibility = subject?.['engram:visibility'] as string | undefined
  const isPrivate = visibility === 'private' || scope === 'local'
  fields.scope = scope
  fields.visibility = visibility
  fields.may_leave_this_machine = !isPrivate
  if (scope) lines.push(`Scope         ${scope}${visibility ? `, ${visibility}` : ''}`)
  const at = (n: unknown) => String((n as { '@value'?: string })?.['@value'] ?? n ?? '')
  const idOf = (n: unknown) => String((n as { '@id'?: string })?.['@id'] ?? '').replace(/^engram:/, '')

  // Who
  const who = subject?.['prov:wasAttributedTo']
  if (who) {
    const name = idOf(who)
    // Undo the identifier escaping for display. An identifier may not contain a
    // space; a person's name may, and two testers were shown "Marta%20Kovac"
    // where their colleague's name should have been. The record keeps the legal
    // identifier; what a human reads gets the name back.
    const plain = bidiIsolate(readableAgent(name.replace(/^agent\//, '')))
    fields.asserted_by = plain
    // Somebody WROTE a name here. Nothing checked it, and nothing can:
    // packs are not signed. It was called `identity_known`, which a tester read
    // as a verification claim — it reported true for a name they had invented.
    fields.identity_stated = plain !== 'unidentified'
    lines.push(plain === 'unidentified'
      ? 'Asserted by   nobody identified — no identity was configured at the time'
      : `Asserted by   ${plain}`)
    // The marker is RECORDED information — it says we looked and found nobody,
    // which is different from the field being absent. It is still not an ANSWER
    // to "who is answerable for this", so it belongs in both places: shown as
    // recorded, and counted as unanswered.
    //
    // Getting this wrong would be the more dangerous direction. Once every
    // engram carries the marker, treating it as an answer would let a memory
    // nobody is accountable for report `complete: true`.
    if (plain === 'unidentified') {
      missing.push('who asserted it — the writer recorded that nobody was identified')
    }
  } else {
    missing.push('who asserted it')
  }

  // Written by: a runtime, or a tool, or both. This read `engram:runtimeName`
  // only, so an engram attributed to a tool alone showed no "Written by" line
  // at all while the record named the tool perfectly well.
  const softwareAgents = graph.filter(n => {
    const t = n['@type']
    return Array.isArray(t) && t.includes('prov:SoftwareAgent') && !t.includes('pa:AIModel')
  })
  const written = softwareAgents.map(n => {
    const name = n['engram:runtimeName'] ?? n['engram:toolName']
    const version = n['engram:runtimeVersion'] ?? n['engram:toolVersion']
    return name ? `${name}${version ? ` ${version}` : ''}` : undefined
  }).filter(Boolean) as string[]
  if (written.length) {
    fields.written_by = written.join(', ')
    lines.push(`Written by    ${fields.written_by}`)
  }

  // Which model. The record has named it since models were supported; the
  // summary said only "worked out by a model" and never which one — in a
  // feature whose point includes answering exactly that.
  const modelNode = graph.find(n => {
    const t = n['@type']
    return Array.isArray(t) && t.includes('pa:AIModel')
  })
  if (modelNode?.['engram:modelName']) {
    fields.model = String(modelNode['engram:modelName'])
    const promptVersion = modelNode['engram:promptVersion']
    lines.push(`Model         ${fields.model}${promptVersion ? ` (prompt version ${promptVersion})` : ''}`)
  }

  // Who it was done for. Recorded, and previously shown nowhere.
  const behalf = graph.find(n => n['prov:actedOnBehalfOf'])?.['prov:actedOnBehalfOf']
  if (behalf) {
    fields.on_behalf_of = readableAgent(idOf(behalf).replace(/^agent\//, ''))
    lines.push(`On behalf of  ${fields.on_behalf_of}`)
  }

  // What kind of claim
  const claim = subject?.['engram:claimClass'] as string | undefined
  if (claim) {
    fields.claim_class = claim
    fields.claim_meaning = CLAIM_MEANING[claim]
    lines.push(`Kind of claim ${claim} — ${CLAIM_MEANING[claim] ?? 'unknown kind'}`)
  }
  else missing.push('what kind of claim it is — whether a person stated it or a model worked it out')

  // When
  const when = subject?.['prov:generatedAtTime']
  if (when) {
    fields.first_written = at(when)
    lines.push(`First written ${at(when).slice(0, 10)}`)
  }
  else missing.push('when it was written')

  // What from. Three ways an origin can be recorded, and all three have to be
  // read: an external address, a free-text note, and a link to the engram this
  // one was derived from. Missing the third meant `--derived-from` recorded
  // `prov:wasDerivedFrom` in the record while the summary reported "what it
  // came from" as not recorded — directly contradicting the footer beneath it,
  // which promises nothing was left blank that somebody had recorded.
  const source = subject?.['prov:hadPrimarySource']
  const note = subject?.['engram:sourceNote']
  const derived = subject?.['prov:wasDerivedFrom']
  if (source) {
    fields.came_from = { value: idOf(source) || String(source), is_link: true }
    lines.push(`Came from     ${fields.came_from.value}`)
  } else if (note) {
    fields.came_from = { value: String(note), is_link: false }
    lines.push(`Came from     ${note}  (a note, not a link)`)
  }
  if (derived) {
    const parents = (Array.isArray(derived) ? derived : [derived]).map(idOf).filter(Boolean)
    if (parents.length) {
      fields.derived_from = parents
      lines.push(`Derived from  ${parents.join(', ')}`)
    }
  }
  if (!source && !note && !fields.derived_from) missing.push('what it came from')

  // May I use it
  const licence = subject?.['engram:license'] as string | undefined
  const licenceSource = (subject?.['engram:licenseSource'] as LicenseSource | undefined) ?? 'chosen'
  const defaulted = !wasDecided(licenceSource)
  if (licence) {
    const meaning = LICENCE_MEANING[licence.trim().toLowerCase()]
    fields.licence = { name: licence, chosen: !defaulted, meaning, source: licenceSource }

    // Answer the two questions a machine actually asks, from the policy rather
    // than from the prose. A consumer was left matching on a free-text meaning
    // string — and for a licence we do not recognise that string is absent, so
    // `meaning.includes('NOT for commercial')` waved through everything
    // proprietary. Undetermined is `null`, never `false`, and never `true`.
    const policy = subject?.['odrl:hasPolicy'] as Node | undefined
    const recognised = policy?.['engram:licenseRecognised'] !== false && policy !== undefined
    fields.licence_recognised = recognised
    // Machine-readable too. The prose warned that nobody chose the licence
    // while the JSON granted commercial reuse with no hedge at all, so a
    // consumer reading only the booleans could not see the difference.
    fields.licence_chosen = !defaulted
    if (!recognised) {
      // FAIL CLOSED. These were `null` for "undetermined", which is the honest
      // word but the dangerous value: a tester pointed out that any consumer
      // written as `if (x !== false)` reads null as permission. For a field
      // that gates reuse, not knowing has to mean no. `licence_recognised`
      // carries the distinction between "no" and "we could not tell".
      fields.may_reuse_commercially = false
      fields.may_redistribute = false
    }
    // A policy-level note, whichever branch produced it. This used to print
    // only for an unrecognised licence, so `proprietary` — the one licence
    // whose whole content is "you may not" — carried its explanation in the
    // record and showed nothing to the person reading the summary.
    const policyNote = policy?.['engram:note']
    if (policyNote) lines.push(`              ${String(policyNote).split('. ')[0]}.`)
    if (recognised && policy) {
      const forbidden = ((policy['odrl:prohibition'] ?? []) as Node[]).map(x => x['odrl:action'])
      const permitted = ((policy['odrl:permission'] ?? []) as Node[])
        .flatMap(x => (Array.isArray(x['odrl:action']) ? x['odrl:action'] : [x['odrl:action']]))
      fields.may_reuse_commercially = !forbidden.includes('odrl:commercialize')
      // Redistribution needs BOTH: the licence must permit it and the memory
      // must be cleared to leave. Either one saying no means no.
      fields.may_redistribute = permitted.includes('odrl:distribute')
        && !forbidden.includes('odrl:distribute')
    }

    // A grant NOBODY MADE does not answer a permission question.
    //
    // The record still reports `cc-by-sa-4.0`, because §2.3 of the standard
    // makes a schema default part of the data model: a consumer must read an
    // absent field as holding its default, and the JSON-LD has no business
    // contradicting that.
    //
    // But these two booleans are not a description, they are an answer to "may
    // I?" — and answering yes on the strength of a default nobody chose is the
    // same failure we already fixed one branch up, where a missing policy was
    // being read as permission. We were failing closed on a licence we could
    // not RECOGNISE and failing open on one nobody had SELECTED, which is
    // backwards: at least the unrecognised one was chosen by somebody.
    //
    // `configuredDefault` and `inheritedFromPack` still answer, because a
    // person decided in both cases — once in advance, or once for the pack.
    if (licenceSource === 'schemaDefault') {
      fields.may_reuse_commercially = false
      fields.may_redistribute = false
    }
    const reads = meaning ? ` \u2014 ${meaning}` : ' \u2014 not one we recognise, read it yourself'
    lines.push(`Licence       ${licence}${reads}`)
    // A licence nobody chose is a schema default, not a decision. It still
    // applies, so print it \u2014 but never beside recorded facts unmarked.
    if (defaulted) {
      // Say WHICH kind of unchosen. "Inherited from the pack" and "the schema
      // default nobody has ever looked at" were reported with one sentence, and
      // they are different facts about who, if anybody, granted anything.
      lines.push(licenceSource === 'inheritedFromPack'
        ? '              Inherited from the pack; nobody licensed this memory itself.'
        : '              Nobody chose this licence; it is the default.')
      missing.push(licenceSource === 'inheritedFromPack'
        ? 'a licence for this memory itself; the pack\'s licence above is what applies'
        : 'a licence was never chosen; the default above applies')
    }
    // The licence answers "may I reuse the content", never "may I share this
    // memory". A tester read "reuse allowed" as permission to pass on a private
    // local secret. Say which question was answered, next to the answer.
    if (isPrivate) {
      lines.push('              Not permission to share: this memory is marked private.')
    }
  } else {
    missing.push('whether you may reuse it')
  }

  // History, if any
  const activities = graph.filter(n => {
    const t = n['@type']
    return Array.isArray(t) && t.includes('prov:Activity')
  })
  if (activities.length) {
    fields.recorded_steps = activities.length
    // Name the steps. A bare count told a tester nothing.
    const names = activities.map(a => {
      const t = (a['@type'] as string[]).find(x => x.startsWith('engram:')) ?? ''
      return t.replace('engram:', '').toLowerCase()
    })
    lines.push(`History       ${names.join(', ')}`)
  }

  const invalidated = subject?.['prov:wasInvalidatedBy']
  if (invalidated) {
    fields.retired = true
    lines.push('Status        RETIRED — this memory is no longer believed')
  }

  // A memory that has been REPLACED is the single most decision-relevant fact
  // there is, and the summary was reporting `complete: true` over it. An agent
  // tester put it plainly: "I would have told my human that memory was
  // reliable and current. It had been corrected five minutes earlier."
  const replacedBy = subject?.['engram:supersededBy']
  if (replacedBy) {
    const ids = (Array.isArray(replacedBy) ? replacedBy : [replacedBy]).map(idOf).filter(Boolean)
    if (ids.length) {
      fields.superseded_by = ids
      // First line after the heading. A reader deciding whether to rely on
      // this needs it before anything else, not below the licence.
      lines.splice(0, 0, `SUPERSEDED    replaced by ${ids.join(', ')} — prefer that one`)
      // NOT added to `missing`. It is recorded — that is the whole point — and
      // listing it under "not recorded" put a flat contradiction in one object.
      // `complete` is driven false below instead: complete means "nothing more
      // to know", and a memory that has been replaced always has more.
    }
  }

  const revisionOf = subject?.['prov:wasRevisionOf']
  if (revisionOf) {
    const parents = (Array.isArray(revisionOf) ? revisionOf : [revisionOf]).map(idOf).filter(Boolean)
    if (parents.length) {
      fields.revision_of = parents
      lines.splice(1, 0, `Replaces      ${parents.join(', ')}`)
    }
  }

  return {
    engram_id: engramId,
    private: isPrivate,
    fields,
    lines,
    missing,
    // Never "nothing is missing" about a memory that has been withdrawn.
    // Whatever else is recorded, that is the thing a reader has to know.
    complete: missing.length === 0 && !fields.retired && !fields.superseded_by,
  }
}

/** Render a summary as text, ready to print. */
export function renderProvenanceSummary(summary: ProvenanceSummary): string {
  const out: string[] = []
  out.push(`Where ${summary.engram_id} came from`)
  out.push('='.repeat(`Where ${summary.engram_id} came from`.length))
  out.push('')
  for (const line of summary.lines) out.push(`  ${line}`)

  if (summary.missing.length) {
    out.push('')
    out.push('  Not recorded:')
    for (const gap of summary.missing) out.push(`    - ${gap}`)
    out.push('')
    out.push('  These are not guesses left blank — nothing recorded them.')
  }
  return out.join('\n')
}
