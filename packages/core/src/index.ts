import { detectPlurStorage, type PlurPaths } from './storage.js'
import { loadConfig } from './config.js'
import { loadEngrams, saveEngrams, generateEngramId, loadAllPacks } from './engrams.js'
import { searchEngrams } from './fts.js'
import { selectAndSpread, scoreEngramsPublic } from './inject.js'
import { reactivate } from './decay.js'
import { captureEpisode, queryTimeline } from './episodes.js'
import { detectConflicts } from './conflict.js'
import { installPack, listPacks, exportPack } from './packs.js'
import type { Engram } from './schemas/engram.js'
import type { Episode } from './schemas/episode.js'
import type { PackManifest } from './schemas/pack.js'
import type { PlurConfig } from './schemas/config.js'
import type {
  LearnContext,
  RecallOptions,
  InjectOptions,
  InjectionResult,
  CaptureContext,
  TimelineQuery,
} from './types.js'

export type { Engram } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PackManifest } from './schemas/pack.js'
export type { PlurConfig } from './schemas/config.js'
export * from './types.js'

export interface IngestOptions {
  source?: string
  extract_only?: boolean
  scope?: string
  domain?: string
}

export interface IngestCandidate {
  statement: string
  type: 'behavioral' | 'architectural' | 'procedural'
  source?: string
}

export interface StatusResult {
  engram_count: number
  episode_count: number
  pack_count: number
  storage_root: string
  config: PlurConfig
}

const INGEST_PATTERNS = [
  { re: /(?:we decided|the decision is|agreed to)\s+(.+?)\.?$/gim, type: 'architectural' as const },
  { re: /(?:always|never|must|should)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:the convention is|the rule is|the pattern is)\s+(.+?)\.?$/gim, type: 'procedural' as const },
  { re: /(?:use|prefer)\s+(\w+)\s+(?:for|over|instead of)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:important|note|remember):\s*(.+?)\.?$/gim, type: 'behavioral' as const },
]

export class Plur {
  private paths: PlurPaths
  private config: PlurConfig

  constructor(options?: { path?: string }) {
    this.paths = detectPlurStorage(options?.path)
    this.config = loadConfig(this.paths.config)
  }

  /** Create engram, detect conflicts, save. Returns the created engram. */
  learn(statement: string, context?: LearnContext): Engram {
    const engrams = loadEngrams(this.paths.engrams)
    const id = generateEngramId(engrams)
    const scope = context?.scope ?? 'global'
    const now = new Date().toISOString()

    // Detect conflicts among active engrams in the same scope
    const conflictingEngrams = detectConflicts({ statement, scope }, engrams)
    const conflictIds = conflictingEngrams.map(e => e.id)

    const engram: Engram = {
      id,
      version: 2,
      status: 'active',
      consolidated: false,
      type: context?.type ?? 'behavioral',
      scope,
      visibility: 'private',
      statement,
      domain: context?.domain,
      activation: {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 0,
        last_accessed: now.slice(0, 10),
      },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 1,
      tags: [],
      pack: null,
      abstract: null,
      derived_from: null,
      relations: conflictIds.length > 0 ? {
        broader: [],
        narrower: [],
        related: [],
        conflicts: conflictIds,
      } : undefined,
    }

    engrams.push(engram)
    saveEngrams(this.paths.engrams, engrams)
    return engram
  }

  /** Search engrams, filter by scope/domain/strength, reactivate accessed. */
  recall(query: string, options?: RecallOptions): Engram[] {
    let engrams = loadEngrams(this.paths.engrams)

    // Only active engrams
    engrams = engrams.filter(e => e.status === 'active')

    // Filter by domain if specified
    if (options?.domain) {
      engrams = engrams.filter(e => e.domain?.startsWith(options.domain!))
    }

    // Filter by min_strength if specified
    if (options?.min_strength !== undefined) {
      engrams = engrams.filter(e => e.activation.retrieval_strength >= options.min_strength!)
    }

    // Scope filter: if scope specified, include global + matching scopes
    if (options?.scope) {
      const scope = options.scope
      engrams = engrams.filter(e =>
        e.scope === 'global' ||
        e.scope === scope ||
        e.scope.startsWith(scope)
      )
    }

    const limit = options?.limit ?? 20
    const results = searchEngrams(engrams, query, limit)

    // Reactivate accessed engrams
    if (results.length > 0) {
      const allEngrams = loadEngrams(this.paths.engrams)
      const resultIds = new Set(results.map(e => e.id))
      let modified = false
      for (const e of allEngrams) {
        if (resultIds.has(e.id)) {
          e.activation.retrieval_strength = reactivate(e.activation.retrieval_strength)
          e.activation.last_accessed = new Date().toISOString().slice(0, 10)
          e.activation.frequency += 1
          modified = true
        }
      }
      if (modified) saveEngrams(this.paths.engrams, allEngrams)
    }

    return results
  }

  /** Scored injection within token budget. Returns formatted strings. */
  inject(task: string, options?: InjectOptions): InjectionResult {
    const engrams = loadEngrams(this.paths.engrams)
    const packs = loadAllPacks(this.paths.packs)
    const budget = options?.budget ?? this.config.injection_budget ?? 2000

    const result = selectAndSpread(
      {
        prompt: task,
        scope: options?.scope,
        maxTokens: budget,
      },
      engrams,
      packs,
      {
        spread_cap: this.config.injection?.spread_cap,
        spread_budget: this.config.injection?.spread_budget,
      },
    )

    const formatEngrams = (wires: typeof result.directives): string => {
      if (wires.length === 0) return ''
      return wires.map(e => `[${e.id}] ${e.statement}`).join('\n')
    }

    const directivesStr = formatEngrams(result.directives)
    const considerStr = formatEngrams(result.consider)
    const count = result.directives.length + result.consider.length
    const tokensUsed = result.tokens_used.directives + result.tokens_used.consider

    return {
      directives: directivesStr,
      consider: considerStr,
      count,
      tokens_used: tokensUsed,
    }
  }

  /** Update feedback_signals and adjust retrieval_strength. */
  feedback(id: string, signal: 'positive' | 'negative' | 'neutral'): void {
    const engrams = loadEngrams(this.paths.engrams)
    const engram = engrams.find(e => e.id === id)
    if (!engram) throw new Error(`Engram not found: ${id}`)

    if (!engram.feedback_signals) {
      engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
    }
    engram.feedback_signals[signal] += 1

    // Adjust retrieval strength based on feedback
    if (signal === 'positive') {
      engram.activation.retrieval_strength = Math.min(1.0, engram.activation.retrieval_strength + 0.05)
    } else if (signal === 'negative') {
      engram.activation.retrieval_strength = Math.max(0.0, engram.activation.retrieval_strength - 0.1)
    }

    saveEngrams(this.paths.engrams, engrams)
  }

  /** Set engram status to 'retired'. */
  forget(id: string, reason?: string): void {
    const engrams = loadEngrams(this.paths.engrams)
    const engram = engrams.find(e => e.id === id)
    if (!engram) throw new Error(`Engram not found: ${id}`)

    engram.status = 'retired'
    if (reason && !engram.rationale) {
      engram.rationale = `Retired: ${reason}`
    }

    saveEngrams(this.paths.engrams, engrams)
  }

  /** Capture an episodic memory. */
  capture(summary: string, context?: CaptureContext): Episode {
    return captureEpisode(this.paths.episodes, summary, context)
  }

  /** Query the episode timeline. */
  timeline(query?: TimelineQuery): Episode[] {
    return queryTimeline(this.paths.episodes, query)
  }

  /** Rule-based extraction of engram candidates from content. */
  ingest(content: string, options?: IngestOptions): IngestCandidate[] {
    const candidates: IngestCandidate[] = []
    const seen = new Set<string>()

    for (const { re, type } of INGEST_PATTERNS) {
      re.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(content)) !== null) {
        // Use the last meaningful capture group as the statement
        const captured = match.slice(1).filter(Boolean).join(' ').trim()
        if (!captured || captured.length < 5) continue
        if (seen.has(captured.toLowerCase())) continue
        seen.add(captured.toLowerCase())
        candidates.push({
          statement: captured,
          type,
          source: options?.source,
        })
      }
    }

    // If not extract_only, save the candidates as actual engrams
    if (!options?.extract_only && candidates.length > 0) {
      for (const candidate of candidates) {
        this.learn(candidate.statement, {
          type: candidate.type,
          scope: options?.scope ?? 'global',
          domain: options?.domain,
          source: candidate.source,
        })
      }
    }

    return candidates
  }

  /** Install a pack from a source path. */
  installPack(source: string): { installed: number; name: string } {
    return installPack(this.paths.packs, source)
  }

  /** Export engrams as a shareable pack. */
  exportPack(
    engrams: Engram[],
    outputDir: string,
    manifest: { name: string; version: string; description?: string; creator?: string },
  ): { path: string; engram_count: number } {
    return exportPack(engrams, outputDir, manifest)
  }

  /** List all installed packs. */
  listPacks(): ReturnType<typeof listPacks> {
    return listPacks(this.paths.packs)
  }

  /** Return system health info. */
  status(): StatusResult {
    const engrams = loadEngrams(this.paths.engrams)
    const episodes = queryTimeline(this.paths.episodes)
    const packs = listPacks(this.paths.packs)

    return {
      engram_count: engrams.filter(e => e.status !== 'retired').length,
      episode_count: episodes.length,
      pack_count: packs.length,
      storage_root: this.paths.root,
      config: this.config,
    }
  }
}
