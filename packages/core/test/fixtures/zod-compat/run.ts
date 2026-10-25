/**
 * Runs the corpus (corpus.ts) and reduces each result to a JSON-safe record
 * that can be compared byte for byte with golden.json.
 */
import { CASES, CUSTOM_MESSAGES, SCHEMAS } from './corpus.js'

const UNDEFINED = '<undefined>'
const LOAD_DATE = '<schema-load-date>'

/** JSON with explicit `undefined` values kept visible, so a key that is
 *  present-but-undefined differs from a missing key. Key order is kept. */
function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? UNDEFINED : v)))
}

export interface CaseResult {
  schema: string
  name: string
  success: boolean
  data?: unknown
  /** Sorted, de-duplicated issue paths of a rejected input. */
  paths?: string[]
  /** Schema-defined messages among the issues. */
  messages?: string[]
}

export function runCorpus(): CaseResult[] {
  // The engram activation default is computed when the schema module loads.
  const loadDate = new Date().toISOString().slice(0, 10)
  return CASES.map(({ schema, name, input }) => {
    const parsed = (SCHEMAS[schema] as any).safeParse(input)
    if (parsed.success) {
      const data = toJson(parsed.data) as any
      if (data && typeof data === 'object' && data.activation?.last_accessed === loadDate && !(input as any)?.activation) {
        data.activation.last_accessed = LOAD_DATE
      }
      return { schema, name, success: true, data }
    }
    const issues = parsed.error.issues as Array<{ path: PropertyKey[]; message: string }>
    const paths = [...new Set(issues.map((i) => i.path.map(String).join('.') || '(root)'))].sort()
    const messages = [...new Set(issues.map((i) => i.message).filter((m) => CUSTOM_MESSAGES.includes(m)))].sort()
    return { schema, name, success: false, paths, messages }
  })
}
