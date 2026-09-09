import { dirname, resolve } from 'node:path'

/** A synced leaf can still disappear if a newly created ancestor is lost.
 * Walk on every acknowledgement: an earlier failed write may have left the
 * directories present without ever making their parent entries durable. */
export function* directoryAncestry(directory: string): Generator<string> {
  let current = resolve(directory)
  for (;;) {
    yield current
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}
