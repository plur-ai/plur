// Hook-file shape checks shared by plur init, plur-mcp init and plur doctor.

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Where a nested `hooks` section (Claude Code settings.json, Codex
 * hooks.json: event → list of entries → `hooks` list of hook objects)
 * departs from that shape, as the first offending path, or null when it can
 * be merged.
 *
 * The one shape check every hook installer leg runs before it merges into a
 * user's hooks file (#1352, #1897). A hand-edited file that breaks the
 * structure made the installers and `plur doctor` throw midway. A malformed
 * section is refused instead: the caller skips the hooks step, names the
 * offending path, and never writes the file.
 *
 * Absent or null levels are fine (nothing to merge into). A hook's own fields
 * are not checked: a command-less hook is a prompt/agent hook, which the
 * PLUR-ownership matchers already handle (#1279).
 */
export function hooksShapeProblem(hooks: unknown): string | null {
  if (hooks === undefined || hooks === null) return null
  if (!isObject(hooks)) return '`hooks` is not an object'
  for (const [event, entries] of Object.entries(hooks)) {
    if (entries === null) continue
    if (!Array.isArray(entries)) return `hooks.${event} is not a list`
    for (const [i, entry] of entries.entries()) {
      if (!isObject(entry)) return `hooks.${event}[${i}] is not an object`
      if (entry.hooks == null) continue
      if (!Array.isArray(entry.hooks)) return `hooks.${event}[${i}].hooks is not a list`
      const bad = entry.hooks.findIndex(h => !isObject(h))
      if (bad !== -1) return `hooks.${event}[${i}].hooks[${bad}] is not an object`
    }
  }
  return null
}

/**
 * The same check for Cursor's flat `hooks` section (event → list of command
 * objects, one level shallower than the nested shape).
 */
export function flatHooksShapeProblem(hooks: unknown): string | null {
  if (hooks === undefined || hooks === null) return null
  if (!isObject(hooks)) return '`hooks` is not an object'
  for (const [event, entries] of Object.entries(hooks)) {
    if (entries === null) continue
    if (!Array.isArray(entries)) return `hooks.${event} is not a list`
    const bad = entries.findIndex(e => !isObject(e))
    if (bad !== -1) return `hooks.${event}[${bad}] is not an object`
  }
  return null
}

/** What the harness expects where `problem` was found, for the skip message. */
export function hooksShapeExpectation(problem: string, harness: string, flat = false): string {
  if (problem.startsWith('`hooks` ')) {
    return `${harness} expects an object mapping each event to a list of ${flat ? 'hook objects' : 'hook entries'}`
  }
  return `${harness} expects lists of hook objects there`
}
