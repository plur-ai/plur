// packages/core/src/meta/platitudes.ts

/** Patterns that are too generic to be useful as meta-engrams */
export const PLATITUDE_PATTERNS: string[] = [
  'always be careful',
  'verify before acting',
  'plan ahead',
  'consider edge cases',
  'communicate clearly',
  'test thoroughly',
  'keep it simple',
  'document your work',
  'think before you act',
  'double check',
]

export function isPlatitude(statement: string): boolean {
  const lower = statement.toLowerCase()
  return PLATITUDE_PATTERNS.some(p => lower.includes(p)) || statement.length < 30
}
