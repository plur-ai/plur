/**
 * Parse-behaviour corpus for the Zod schemas in @plur-ai/core.
 *
 * Every case is fed to its schema's `safeParse` by `runCorpus()`, and the
 * result is compared with `golden.json`. The golden file was produced by
 * `generate.ts` against @plur-ai/core 0.22.1 (zod 3.25.76), so the comparison
 * pins what stores, packs and configs written by that release parse to:
 * defaults filled in, keys kept or dropped, key order, explicit `undefined`
 * values, and which paths a rejected input fails on.
 *
 * Default Zod messages are not pinned (zod 4 rewords them), but messages the
 * schemas set themselves are: see CUSTOM_MESSAGES.
 */
import { EngramSchema, EngramSchemaPassthrough, InsightFieldSchema, ExtractionProvenanceSchema } from '../../../src/schemas/engram.js'
import { EpisodeSchema } from '../../../src/schemas/episode.js'
import { PackManifestSchema } from '../../../src/schemas/pack.js'
import {
  PlurConfigSchema,
  StoreEntrySchema,
  ServerStoreEntrySchema,
  DiscoveryCacheSchema,
  ScopeSettingsSchema,
  DedupConfigSchema,
  TensionsConfigSchema,
} from '../../../src/schemas/config.js'
import { ScopeMetadataSchema, ScopeSensitivitySchema } from '../../../src/schemas/scope-metadata.js'
import { TensionRecordSchema } from '../../../src/schemas/tension.js'
import { MetaFieldSchema } from '../../../src/schemas/meta-engram.js'
import { CapsuleHeaderSchema } from '../../../src/schemas/capsule.js'
import { FolderMapSchema } from '../../../src/folder-map-check.js'
import { RemoteRowSchema } from '../../../src/store/remote-store.js'

export const SCHEMAS = {
  EngramSchema,
  EngramSchemaPassthrough,
  InsightFieldSchema,
  ExtractionProvenanceSchema,
  EpisodeSchema,
  PackManifestSchema,
  PlurConfigSchema,
  StoreEntrySchema,
  ServerStoreEntrySchema,
  DiscoveryCacheSchema,
  ScopeSettingsSchema,
  DedupConfigSchema,
  TensionsConfigSchema,
  ScopeMetadataSchema,
  ScopeSensitivitySchema,
  TensionRecordSchema,
  MetaFieldSchema,
  CapsuleHeaderSchema,
  FolderMapSchema,
  RemoteRowSchema,
} as const

export type SchemaName = keyof typeof SCHEMAS

/** Messages the schemas define themselves; these must survive the upgrade word for word. */
export const CUSTOM_MESSAGES = [
  'StoreEntry requires exactly one of path or url',
  'At least one of example or analogy must be provided',
  'A promoted insight must be grounded (grounding=verified); speculative dreams cannot be promoted until re-grounded.',
  'must not contain control characters or newlines (directive-surface hardening, #345)',
  'sha256 must be 64 lowercase hex chars',
]

const ENG_MIN = { id: 'ENG-2026-0319-001', statement: 'API uses snake_case', type: 'behavioral', scope: 'global', status: 'active' }
const ACT = { retrieval_strength: 0.5, storage_strength: 0.9, frequency: 3, last_accessed: '2026-10-01' }
const ENG_FULL = {
  id: 'ENG-2026-0601-007',
  version: 2,
  status: 'active',
  consolidated: true,
  type: 'procedural',
  scope: 'project:my-app',
  visibility: 'public',
  created_at: '2026-06-01T10:00:00.000Z',
  statement: 'Run pnpm -r build after switching branches',
  rationale: 'A partial rebuild leaves stale dist imports',
  contraindications: ['single-package repos'],
  source: 'session',
  source_patterns: ['P-1'],
  derivation_count: 2,
  pack: null,
  abstract: null,
  derived_from: 'ENG-2026-0501-001',
  knowledge_type: { memory_class: 'procedural', cognitive_level: 'apply' },
  domain: 'software.build',
  tags: ['pnpm', 'build'],
  activation: ACT,
  relations: { broader: ['ENG-2026-0101-001'], supersedes: [] },
  associations: [{ target_type: 'engram', target: 'ENG-2026-0101-002', strength: 0.4, type: 'semantic' }],
  knowledge_anchors: [{ path: 'docs/build.md' }, { path: 'README.md', relevance: 'primary', snippet: 'pnpm build' }],
  dual_coding: { example: 'pnpm -r build' },
  provenance: { origin: 'local', chain: ['a'] },
  attribution: { asserted_by: 'unidentified', runtime: { name: 'plur-mcp', version: '0.22.1' } },
  claim_class: 'asserted',
  feedback_signals: { positive: 2, negative: 0, neutral: 1 },
  entities: [{ name: 'pnpm', type: 'tool', uri: 'https://pnpm.io' }],
  temporal: { learned_at: '2026-06-01', valid_from: '2026-06-01' },
  usage: { hits: 4 },
  episodic: { trigger_context: 'branch switch' },
  exchange: { fitness_score: 0.5 },
  structured_data: { extraction: { confidence: 0.9, source_commit: 'abc' }, n: 1 },
  polarity: 'do',
  content_hash: 'deadbeef',
  commitment: 'decided',
  write_count: 3,
  injection_count: 7,
  sources: [{ scope: 'project:my-app', stored_at: '2026-06-01T10:00:00.000Z' }, { scope: 'global', session_id: 's1', stored_at: '2026-06-02T10:00:00.000Z', validated_by: 'group:a/b' }],
  recurrence_count: 1,
  engram_version: 2,
  previous_version_ref: { event_id: 'EV-1', changed_at: '2026-06-02' },
  episode_ids: ['EP-1'],
  summary: 'pnpm -r build after branch switch',
  pinned: true,
  pinned_tier: 'soft',
  pinned_priority: 60,
}

export interface Case { schema: SchemaName; name: string; input: unknown }

export const CASES: Case[] = [
  // ---- Engrams -----------------------------------------------------------
  { schema: 'EngramSchema', name: 'minimal engram gets every default', input: ENG_MIN },
  { schema: 'EngramSchema', name: 'full engram round-trips', input: ENG_FULL },
  { schema: 'EngramSchemaPassthrough', name: 'full engram round-trips (passthrough)', input: ENG_FULL },
  { schema: 'EngramSchema', name: 'unknown top-level key is stripped', input: { ...ENG_MIN, future_field: { a: 1 } } },
  { schema: 'EngramSchemaPassthrough', name: 'unknown top-level key is kept', input: { ...ENG_MIN, future_field: { a: 1 }, zz: 'last' } },
  { schema: 'EngramSchema', name: 'explicit nulls on nullable fields', input: { ...ENG_MIN, pack: null, polarity: null, abstract: null } },
  { schema: 'EngramSchema', name: 'explicit undefined on optional fields', input: { ...ENG_MIN, domain: undefined, rationale: undefined, relations: undefined } },
  { schema: 'EngramSchema', name: 'empty nested objects fill their own defaults', input: { ...ENG_MIN, relations: {}, usage: {}, episodic: {}, exchange: {}, feedback_signals: {}, provenance: { origin: 'x' } } },
  { schema: 'EngramSchema', name: 'insight defaults', input: { ...ENG_MIN, insight: { operation: 'dream', synthesized_at: '2026-06-01' } } },
  { schema: 'EngramSchema', name: 'store-namespaced id', input: { ...ENG_MIN, id: 'ENG-PPLTPHQPYTD-2026-09-01-040' } },
  { schema: 'EngramSchema', name: 'META and ABS ids', input: { ...ENG_MIN, id: 'META-2026-0101-001' } },
  { schema: 'EngramSchema', name: 'draft commitment', input: { ...ENG_MIN, commitment: 'draft' } },
  { schema: 'EngramSchema', name: 'legacy dormant status', input: { ...ENG_MIN, status: 'dormant' } },
  { schema: 'EngramSchema', name: 'reject: missing statement', input: { id: 'ENG-2026-0319-001', type: 'behavioral' } },
  { schema: 'EngramSchema', name: 'reject: bad id', input: { ...ENG_MIN, id: 'eng-1' } },
  { schema: 'EngramSchema', name: 'reject: bad enum', input: { ...ENG_MIN, type: 'nope', status: 'gone' } },
  { schema: 'EngramSchema', name: 'reject: summary too long', input: { ...ENG_MIN, summary: 'x'.repeat(81) } },
  { schema: 'EngramSchema', name: 'reject: dual coding empty', input: { ...ENG_MIN, dual_coding: {} } },
  { schema: 'EngramSchema', name: 'reject: promoted insight ungrounded', input: { ...ENG_MIN, insight: { operation: 'dream', synthesized_at: 'x', fate: 'promoted' } } },
  { schema: 'EngramSchema', name: 'reject: association strength above 0.95', input: { ...ENG_MIN, associations: [{ target_type: 'engram', target: 'x', strength: 0.99, type: 'semantic' }] } },
  { schema: 'EngramSchema', name: 'reject: entity uri not a url', input: { ...ENG_MIN, entities: [{ name: 'a', type: 'tool', uri: 'not a url' }] } },
  { schema: 'EngramSchema', name: 'reject: non-integer frequency', input: { ...ENG_MIN, activation: { ...ACT, frequency: 1.5 } } },
  { schema: 'EngramSchema', name: 'reject: pinned_priority out of range', input: { ...ENG_MIN, pinned_priority: 0 } },
  { schema: 'EngramSchema', name: 'reject: not an object', input: 'just a string' },
  { schema: 'InsightFieldSchema', name: 'insight promoted and verified', input: { operation: 'distill', synthesized_at: 'x', fate: 'promoted', grounding: 'verified' } },
  { schema: 'ExtractionProvenanceSchema', name: 'extraction provenance keeps extra keys', input: { confidence: 0.4, extra: true } },

  // ---- Episodes ----------------------------------------------------------
  { schema: 'EpisodeSchema', name: 'episode minimal', input: { id: 'EP-1', summary: 's', timestamp: '2026-01-01T00:00:00Z' } },
  { schema: 'EpisodeSchema', name: 'episode full, unknown key stripped', input: { id: 'EP-1', summary: 's', agent: 'a', channel: 'c', session_id: 'x', tags: ['t'], timestamp: 't', extra: 1 } },
  { schema: 'EpisodeSchema', name: 'reject: episode missing timestamp', input: { id: 'EP-1', summary: 's' } },

  // ---- Packs -------------------------------------------------------------
  { schema: 'PackManifestSchema', name: 'pack minimal', input: { name: 'p', version: '1.0.0' } },
  { schema: 'PackManifestSchema', name: 'pack metadata defaults', input: { name: 'p', version: '1.0.0', metadata: {} } },
  { schema: 'PackManifestSchema', name: 'pack full with unknown root key', input: { name: 'p', version: '1', description: 'd', creator: 'c', license: 'mit', tags: ['a'], metadata: { id: 'x', injection_policy: 'always', match_terms: ['m'], domain: 'd', engram_count: 3, provenance: true }, 'x-future': { a: 1 } } },
  { schema: 'PackManifestSchema', name: 'pack legacy x-datacore', input: { name: 'p', version: '1', 'x-datacore': { id: 'x', injection_policy: 'on_request', engram_count: 2 } } },
  { schema: 'PackManifestSchema', name: 'pack metadata unknown key stripped', input: { name: 'p', version: '1', metadata: { surprise: 1 } } },
  { schema: 'PackManifestSchema', name: 'reject: pack x-datacore always', input: { name: 'p', version: '1', 'x-datacore': { id: 'x', injection_policy: 'always', engram_count: 2 } } },
  { schema: 'PackManifestSchema', name: 'reject: pack missing version', input: { name: 'p' } },

  // ---- Config ------------------------------------------------------------
  { schema: 'PlurConfigSchema', name: 'empty config stays empty', input: {} },
  { schema: 'PlurConfigSchema', name: 'config nested objects present but empty', input: { injection: {}, dedup: {}, provenance: {}, tensions: {}, recurrence: {}, expiry: {}, embeddings: {}, vector: {}, postgres: {}, llm: {}, profile: {}, scope_routing: {}, sync: {} } },
  { schema: 'PlurConfigSchema', name: 'config partial nested values', input: { injection: { spread_cap: 5 }, dedup: { threshold: 0.9 }, llm: { meta_tier: 'fast' }, tensions: { temporal_domains: ['x'] } } },
  { schema: 'PlurConfigSchema', name: 'config scalar settings', input: { auto_learn: false, injection_budget: 1500, packs: ['a'], allow_secrets: true, backend: 'sqlite', unscoped_default: 'local', registry_url: 'https://registry.example.com/x' } },
  { schema: 'PlurConfigSchema', name: 'config unknown key stripped', input: { auto_learn: true, mystery: 1 } },
  { schema: 'PlurConfigSchema', name: 'config with path and remote stores', input: { stores: [
    { path: '/tmp/team', scope: 'group:a/b', shared: true },
    { url: 'https://plur.example.com', token: 't', scope: 'group:a/c', dial: 'always', description: 'd', covers: ['x', 3], sensitivity: { forbid: ['secrets', 'bogus'], allow: 'infra' }, future: 1 },
    { url: 'https://plur.example.com', token_env: 'PLUR_T', scope: 'group:a/d', dial: 'sometimes', covers: 5, sensitivity: 'oops' },
  ] } },
  { schema: 'PlurConfigSchema', name: 'reject: config store with both path and url', input: { stores: [{ path: '/x', url: 'https://x.example.com', scope: 's' }] } },
  { schema: 'PlurConfigSchema', name: 'reject: config bad backend', input: { backend: 'mongo' } },
  { schema: 'PlurConfigSchema', name: 'reject: config bad threshold', input: { dedup: { threshold: 2 } } },
  { schema: 'PlurConfigSchema', name: 'config postgres catches bad numbers', input: { postgres: { url: 'postgres://x', hnsw_m: -1, ef_search: 'x', max_connections: 4 } } },
  { schema: 'PlurConfigSchema', name: 'config scope_routing catches bad values', input: { scope_routing: { match_threshold: 7, weight_tag: 1, allow_shared_auto_route: 'yes' } } },
  { schema: 'DedupConfigSchema', name: 'dedup config empty', input: {} },
  { schema: 'TensionsConfigSchema', name: 'tensions config empty', input: {} },
  { schema: 'StoreEntrySchema', name: 'store entry minimal path', input: { path: '/x', scope: 'global' } },
  { schema: 'StoreEntrySchema', name: 'store entry sensitivity empty object', input: { path: '/x', scope: 'global', sensitivity: {} } },
  { schema: 'StoreEntrySchema', name: 'store entry url with port and path', input: { url: 'http://localhost:8080/api', scope: 's' } },
  { schema: 'StoreEntrySchema', name: 'reject: store entry neither path nor url', input: { scope: 's' } },
  { schema: 'StoreEntrySchema', name: 'reject: store entry bad url', input: { url: 'not a url', scope: 's' } },
  { schema: 'StoreEntrySchema', name: 'reject: store entry missing scope', input: { path: '/x' } },
  { schema: 'ServerStoreEntrySchema', name: 'server entry minimal', input: { url: 'https://plur.example.com', scopes: ['group:a/b'] } },
  { schema: 'ServerStoreEntrySchema', name: 'server entry malformed values dropped', input: {
    url: 'https://plur.example.com', token: 't', scope: 'group:a/b', scopes: ['group:a/b', 7], pinned_scopes: 'nope', enterprise: 'x',
    scope_settings: { 'group:a/b': { dial: 'never', covers: ['c'], sensitivity: { forbid: ['infra'] }, extra: 1 }, 'group:a/c': 'bad' },
    discovery: { discovered_at: 't', scopes_status: 'weird', gitlab_host: null, project_paths: { 'a/b': 'group:a/b', bad: 3 }, key_expires_at: null, status: 'brand-new', extra: true },
    future_key: 'kept',
  } },
  { schema: 'ServerStoreEntrySchema', name: 'server entry scopes not a list', input: { url: 'https://plur.example.com', scopes: 'group:a/b', enterprise: { hello_engram_id: 'ENG-1', other: 2 } } },
  { schema: 'ServerStoreEntrySchema', name: 'reject: server entry bad url', input: { url: 'plur.example.com', scopes: [] } },
  { schema: 'DiscoveryCacheSchema', name: 'discovery cache project_paths bad value', input: { project_paths: { a: 1 } } },
  { schema: 'DiscoveryCacheSchema', name: 'discovery cache project_paths valid', input: { project_paths: { a: 'project:a' }, username: 'u', status: 'ok' } },
  { schema: 'ScopeSettingsSchema', name: 'scope settings bad shapes', input: { dial: 3, description: 4, covers: 'x', sensitivity: [] } },

  // ---- Scope metadata ----------------------------------------------------
  { schema: 'ScopeMetadataSchema', name: 'scope metadata minimal', input: { scope: 'group:a/b', description: 'team' } },
  { schema: 'ScopeMetadataSchema', name: 'scope metadata nulls', input: { scope: 'group:a/b', description: null, sensitivity: null, injection_policy: null, owner: null } },
  { schema: 'ScopeMetadataSchema', name: 'scope metadata full', input: { scope: 's', description: 'd', covers: ['a'], sensitivity: { forbid: ['pii'], allow: ['x', 1] }, injection_policy: 'always', owner: 'o', extra: 1 } },
  { schema: 'ScopeMetadataSchema', name: 'reject: scope metadata control chars', input: { scope: 's', description: 'line\nbreak', covers: ['ok', 'bad\u0007'] } },
  { schema: 'ScopeMetadataSchema', name: 'reject: scope metadata missing description', input: { scope: 's' } },
  { schema: 'ScopeSensitivitySchema', name: 'sensitivity empty', input: {} },
  { schema: 'ScopeSensitivitySchema', name: 'sensitivity all unknown', input: { forbid: ['bogus'], allow: 5, extra: 'kept' } },

  // ---- Tensions, meta, capsules -----------------------------------------
  { schema: 'TensionRecordSchema', name: 'tension defaults', input: { id: 'T-1', engram_a: 'a', engram_b: 'b', statement_a: 'x', statement_b: 'y', confidence: 0.7, reason: 'r', detected_at: 't' } },
  { schema: 'TensionRecordSchema', name: 'reject: tension confidence above 1', input: { id: 'T-1', engram_a: 'a', engram_b: 'b', statement_a: 'x', statement_b: 'y', confidence: 1.7, reason: 'r', detected_at: 't' } },
  { schema: 'MetaFieldSchema', name: 'meta field defaults', input: {
    structure: { goal_type: 'g', constraint_type: 'c', outcome_type: 'o', template: 't' },
    evidence: [{ engram_id: 'a', domain: 'd', mapping_rationale: 'm', alignment_score: 0.5 }, { engram_id: 'b', domain: 'e', mapping_rationale: 'm', alignment_score: 0.6 }],
    domain_coverage: { validated: ['d'] },
    falsification: { expected_conditions: 'x', expected_exceptions: 'y' },
    confidence: { evidence_count: 2, domain_count: 2, structural_depth: 2, composite: 0.5 },
    hierarchy: { level: 'mop' },
    pipeline_version: '1',
  } },
  { schema: 'MetaFieldSchema', name: 'reject: meta field one evidence', input: { evidence: [] } },
  { schema: 'CapsuleHeaderSchema', name: 'capsule header', input: {
    schema: 'plur.capsule/1', product_type: 'engram-pack',
    manifest_summary: { name: 'p', version: '1', engram_count: 2 },
    payload: { compression: 'gzip', size_compressed: 1, size_uncompressed: 2, sha256: 'a'.repeat(64) },
    created_at: '2026-06-01T10:00:00+02:00', producer: { tool: 'plur', version: '0.22.1' },
  } },
  { schema: 'CapsuleHeaderSchema', name: 'capsule header Z timestamp with millis', input: {
    schema: 'plur.capsule/1', product_type: 'skill',
    manifest_summary: { name: 'p', version: '1', engram_count: 0, license: 'mit' },
    payload: { compression: 'none', size_compressed: 1, size_uncompressed: 1, sha256: 'b'.repeat(64) },
    created_at: '2026-06-01T10:00:00.123Z', producer: { tool: 'plur', version: '1' }, signer: { algo: 'ed25519', public_key: 'k' },
  } },
  { schema: 'CapsuleHeaderSchema', name: 'reject: capsule header bad sha and date', input: {
    schema: 'plur.capsule/1', product_type: 'skill',
    manifest_summary: { name: 'p', version: '1', engram_count: 0 },
    payload: { compression: 'none', size_compressed: 1, size_uncompressed: 1, sha256: 'XYZ' },
    created_at: '2026-06-01', producer: { tool: 'plur', version: '1' },
  } },

  // ---- Folder map, remote rows ------------------------------------------
  { schema: 'FolderMapSchema', name: 'folder map', input: { version: 1, folders: [{ path: '~/work', plur: 'remote-only', scope: 'group:a/b', trusted: true, extra: 1 }], other: 'kept' } },
  { schema: 'FolderMapSchema', name: 'folder map null folders', input: { folders: null } },
  { schema: 'FolderMapSchema', name: 'reject: folder map bad entries', input: { version: 2, folders: [{ plur: 'ON' }, 'x', { path: '', trusted: 'yes' }] } },
  { schema: 'RemoteRowSchema', name: 'remote row', input: { id: 'ENG-2026-0101-001', scope: 'group:a/b', status: 'active', statement: 's', confidence_score: null, rationale: null, extra: { a: 1 } } },
  { schema: 'RemoteRowSchema', name: 'reject: remote row drifted fields', input: { id: 'ENG-1', scope: '', status: 'archived', statement: 's', type: 'weird', commitment: 'maybe' } },
]
