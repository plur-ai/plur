/**
 * Declared-but-stubbed import sources (issue #441).
 *
 * Zep and Letta are registered so `--from zep|letta` fails with a clear,
 * actionable message — and so implementing them later is a matter of
 * replacing parse(), not designing a new surface. They are intentionally NOT
 * implemented yet: both export formats churn across versions (Zep's
 * session-graph shape, Letta's agent-file memory blocks), so pinning a parser
 * today would rot quickly.
 */
import type { ImportSource } from './types.js'

function stub(name: string, description: string, detail: string): ImportSource {
  return {
    name,
    description,
    implemented: false,
    parse() {
      throw new Error(
        `The "${name}" importer is not implemented yet. ${detail} ` +
        'The adapter interface is stubbed so it can be added — see https://github.com/plur-ai/plur/issues/441. ' +
        'In the meantime, export to JSON and use --from generic with a --mapping config.'
      )
    },
  }
}

export const zepSource = stub(
  'zep',
  'Zep session graphs (stub — not yet implemented)',
  "Zep's session-graph export format is still churning across versions.",
)

export const lettaSource = stub(
  'letta',
  'Letta agent memory blocks (stub — not yet implemented)',
  "Letta's agent-file memory-block format is still churning across versions.",
)
