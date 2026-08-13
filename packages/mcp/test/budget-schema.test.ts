/**
 * #703 — every field the `budget` schema advertises must do something.
 *
 * `budget.ttl_seconds` was declared on `plur_recall` (and its deprecated alias
 * `plur_recall_hybrid`) and never read by any handler. That is worse than an
 * undocumented field: an agent inspecting the schema reads it as "response
 * caching is configurable here", sets it, and gets no caching and no error. The
 * tool lies about itself, quietly, to exactly the audience that reads schemas.
 *
 * The fix was to remove it. This test is what stops it — or anything like it —
 * coming back: the allow-list below is the set of budget fields the handler
 * actually consults, so adding a schema field without wiring it fails here.
 */
import { describe, it, expect } from 'vitest'
import { getToolDefinitions } from '../src/tools.js'

/**
 * Budget fields `handleRecall` reads.
 *
 * `max_results` caps the result set (and drives the over-fetch-by-one that
 * detects truncation, #725). `max_tokens` bounds the rendered payload. If you
 * add a field here, wire it first — the point of the list is that it is derived
 * from the handler, not from the schema.
 */
const WIRED_BUDGET_FIELDS = ['max_tokens', 'max_results'] as const

function budgetProperties(toolName: string): string[] {
  const tool = getToolDefinitions('full').find(t => t.name === toolName)
  expect(tool, `${toolName} is not in the full profile`).toBeDefined()
  const schema = tool!.inputSchema as {
    properties?: { budget?: { properties?: Record<string, unknown> } }
  }
  const props = schema.properties?.budget?.properties
  expect(props, `${toolName} declares no budget properties`).toBeDefined()
  return Object.keys(props!).sort()
}

describe('the budget schema advertises only fields that are read (#703)', () => {
  it.each(['plur_recall', 'plur_recall_hybrid'])('%s', name => {
    expect(budgetProperties(name)).toEqual([...WIRED_BUDGET_FIELDS].sort())
  })

  it('does not declare ttl_seconds anywhere — nothing caches on it', () => {
    // Named explicitly because this is the field that shipped: a general
    // assertion would pass if someone re-added it under a different tool.
    for (const tool of getToolDefinitions('full')) {
      expect(JSON.stringify(tool.inputSchema), `${tool.name} reintroduced ttl_seconds`)
        .not.toContain('ttl_seconds')
    }
  })

  it('the deprecated alias keeps the same budget contract as plur_recall', () => {
    // They share one handler. A schema that drifts between them means the
    // alias documents behaviour the handler does not have for it.
    expect(budgetProperties('plur_recall_hybrid')).toEqual(budgetProperties('plur_recall'))
  })
})
