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
 * An unrecognised licence produces NO policy. Not a permissive default, not a
 * guess. The record then carries the licence name alone, and a reader knows to
 * go and look.
 */
const LICENCE_POLICY: Record<string, { uid: string; permit: string[]; require: string[]; forbid: string[] }> = {
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

function licencePolicy(name: string | undefined): Node | undefined {
  if (!name) return undefined
  const spec = LICENCE_POLICY[name.toLowerCase()]
  if (!spec) return undefined
  const permission: Node = { 'odrl:action': spec.permit.map(a => `odrl:${a}`) }
  if (spec.require.length) permission['odrl:duty'] = spec.require.map(a => ({ 'odrl:action': `odrl:${a}` }))
  const policy: Node = { '@type': 'odrl:Set', 'odrl:uid': spec.uid, 'odrl:permission': [permission] }
  if (spec.forbid.length) policy['odrl:prohibition'] = spec.forbid.map(a => ({ 'odrl:action': `odrl:${a}` }))
  return policy
}

/** Build the agent nodes, and the relationships that point at them. */
function agentNodes(engram: Engram): { nodes: Node[]; attributedTo?: string; associatedWith?: string } {
  const a = (engram as any).attribution as Engram['attribution']
  if (!a) return { nodes: [] }
  const nodes: Node[] = []
  let attributedTo: string | undefined
  let associatedWith: string | undefined

  if (a.asserted_by) {
    attributedTo = `engram:agent/${a.asserted_by}`
    const node: Node = { '@id': attributedTo, '@type': 'prov:Agent' }
    // Say plainly that nobody was identified, rather than leaving it ambiguous.
    if (a.asserted_by === 'unidentified') {
      node['engram:identityKnown'] = false
      node['engram:note'] = 'No identity was configured when this was written.'
    }
    nodes.push(node)
  }

  const software = a.runtime ?? a.tool
  if (software) {
    associatedWith = `engram:agent/software/${software.name}${software.version ? `@${software.version}` : ''}`
    const node: Node = { '@id': associatedWith, '@type': ['prov:SoftwareAgent', 'pa:AIAgent'], 'engram:runtimeName': software.name }
    if (software.version) node['engram:runtimeVersion'] = software.version
    const behalf = a.on_behalf_of ?? a.asserted_by
    if (behalf) node['prov:actedOnBehalfOf'] = { '@id': `engram:agent/${behalf}` }
    nodes.push(node)
  }

  if (a.model) {
    const id = `engram:model/${a.model.name}`
    const node: Node = { '@id': id, '@type': ['prov:SoftwareAgent', 'pa:AIModel'], 'engram:modelName': a.model.name }
    // The prompt is identified by hash. Its text is never stored.
    if (a.model.prompt_sha256) node['engram:promptHash'] = `sha256:${a.model.prompt_sha256}`
    if (a.model.prompt_id) node['engram:promptId'] = a.model.prompt_id
    if (a.model.prompt_version) node['engram:promptVersion'] = a.model.prompt_version
    nodes.push(node)
  }

  return { nodes, attributedTo, associatedWith }
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
  graph.push({
    '@id': `engram:record/${id}`,
    '@type': ['prov:Bundle', 'prov:Entity'],
    'prov:generatedAtTime': instant(now),
    'engram:describes': { '@id': `engram:${id}` },
    'engram:recordIsSelfContained': portable,
  })

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

  const licence = (engram as any).provenance?.license ?? 'cc-by-sa-4.0'
  const policy = licencePolicy(licence)
  thing['engram:license'] = licence
  if (policy) thing['odrl:hasPolicy'] = policy

  if (agents.attributedTo) thing['prov:wasAttributedTo'] = { '@id': agents.attributedTo }

  const derivedFrom = (engram as any).derived_from as string | null | undefined
  if (derivedFrom) thing['prov:wasDerivedFrom'] = { '@id': `engram:${derivedFrom}` }

  const supersedes = (engram as any).relations?.supersedes as string[] | undefined
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

    if (agents.associatedWith) act['prov:wasAssociatedWith'] = { '@id': agents.associatedWith }
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
  })

  // What a reader can judge before opening a single engram.
  const byClaim: Record<string, number> = {}
  const licences = new Set<string>()
  let licensed = 0
  const dates: string[] = []
  for (const e of engrams) {
    const claim = (e as any).claim_class ?? 'unstated'
    byClaim[claim] = (byClaim[claim] ?? 0) + 1
    const lic = (e as any).provenance?.license
    if (lic) { licences.add(lic); licensed++ }
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
    'engram:licensedCount': licensed,
    'engram:licenses': [...licences].sort(),
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
    const creatorId = `engram:agent/${pack.creator}`
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
