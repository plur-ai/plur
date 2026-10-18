// Small helpers for the corrections / inject / feedback promise evals.
// They read only what a caller of plur.inject() sees: the ids it reports and
// the text it renders. Nothing here computes an expected value.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../../packages/core/src/index.js'
import type { InjectionResult } from '../../packages/core/src/types.js'
import { useEmbedder, type TempStore } from './store.js'

/**
 * Every id the agent was given, in every section: the ids tagged in the text it
 * receives, in order. Never `injected_ids` alone: an id reported there but not
 * rendered was not given (fourth audit A4-03, metadata substituted for delivery).
 */
export function given(r: InjectionResult): string[] {
  const out: string[] = []
  for (const m of renderedText(r).matchAll(/\[(ENG-[^\]\s]+)\]/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** The full text the agent receives, all three sections joined. */
export function renderedText(r: InjectionResult): string {
  return [r.directives, r.constraints, r.consider].filter(s => s.length > 0).join('\n')
}

/** Whether the agent receives this statement whole, word for word (not a tag or a truncated line). */
export function deliversText(r: InjectionResult, statement: string): boolean {
  return renderedText(r).includes(statement)
}

/** Position of an id in the rendered text the agent reads (-1 when absent). */
export function positionInText(r: InjectionResult, id: string): number {
  return renderedText(r).indexOf(`[${id}]`)
}

/**
 * Write a store file by hand, as an import or a hand edit would leave it.
 * Used only where the public write path refuses the input on purpose (for
 * example an unreadable date), to check what reading such a store does.
 */
export function writeRawStore(dir: string, engrams: unknown[]): void {
  writeFileSync(join(dir, 'engrams.yaml'), JSON.stringify({ engrams }) + '\n')
}

/** A throwaway store opened over hand-written memories (keyword search only). */
export async function rawStore(engrams: unknown[]): Promise<TempStore> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-eval-raw-'))
  writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
  writeRawStore(dir, engrams)
  useEmbedder('off')
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  return { plur, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const DAY_MS = 86_400_000

/** An ISO timestamp `days` days (plus one hour, so whole days are never rounded down) before now. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS - 3_600_000).toISOString()
}

/**
 * A stored memory as it would sit on disk, with a chosen strength and last
 * use. Learned long ago, so no "recently learned" bonus applies to it.
 */
export function storedMemory(id: string, statement: string, opts: {
  strength: number
  lastUsedDaysAgo: number
  commitment?: string
  temporal?: Record<string, string>
}): Record<string, unknown> {
  return {
    id, statement, type: 'behavioral', scope: 'global', status: 'active',
    ...(opts.commitment ? { commitment: opts.commitment } : {}),
    ...(opts.commitment === 'locked' ? { locked_reason: 'eval: locked by the owner', locked_at: '2025-01-01T00:00:00.000Z' } : {}),
    temporal: { learned_at: '2025-01-01T00:00:00.000Z', ...(opts.temporal ?? {}) },
    activation: {
      retrieval_strength: opts.strength, storage_strength: 1.0, frequency: 0,
      last_accessed: daysAgo(opts.lastUsedDaysAgo),
    },
  }
}
