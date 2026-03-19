export type { Engram, KnowledgeAnchor, Association } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PlurConfig } from './schemas/config.js'
export type { PackManifest } from './schemas/pack.js'

export interface LearnContext {
  type?: 'behavioral' | 'terminological' | 'procedural' | 'architectural'
  scope?: string
  domain?: string
  source?: string
}

export interface RecallOptions {
  scope?: string
  domain?: string
  limit?: number
  min_strength?: number
}

export interface InjectOptions {
  budget?: number
  scope?: string
  boost_recent?: boolean
}

export interface InjectionResult {
  directives: string
  consider: string
  count: number
  tokens_used: number
}

export interface CaptureContext {
  agent?: string
  channel?: string
  session_id?: string
  tags?: string[]
}

export interface TimelineQuery {
  since?: Date
  until?: Date
  agent?: string
  channel?: string
  search?: string
}
