// TOOL-1: If my agent calls a tool by an old or hidden name, it is told exactly
// how to call it now, never just "unknown tool".
//
// Driven over the MCP wire against a server built from source, in the default
// (lean) profile. "Exactly how" is checked by doing what the answer says: the
// agent copies the action name out of the answer, calls the gateway with it,
// and gets the real result.
import { afterEach, describe, expect, it } from 'vitest'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'

// plur_packs_list: a real tool that the lean profile does not list (hidden).
// plur_recall_hybrid: the deprecated pre-0.16 name of hybrid recall (old).
const CASES = [
  { kind: 'hidden', name: 'plur_packs_list', args: {} },
  { kind: 'old', name: 'plur_recall_hybrid', args: { query: 'billing service deploys' } },
] as const

describe('TOOL-1 an old or hidden tool name gets told how to call it now', () => {
  let s: McpSession
  afterEach(async () => { await s?.close() })

  for (const c of CASES) {
    it(`${c.kind} name ${c.name}`, async () => {
      s = await mcpSession({ profile: 'lean' })
      await s.plur.learn('Billing service deploys use blue-green rollouts', { scope: 'global' })

      const listed = (await s.client.listTools()).tools.map((t: { name: string }) => t.name)
      expect(listed, `precondition: ${c.name} is not a direct tool in the lean profile, so calling it is the case under test`)
        .not.toContain(c.name)
      expect(listed, 'precondition: the gateway tool plur_admin is listed').toContain('plur_admin')

      const direct = await s.call(c.name, c.args)
      expect(direct.text, `calling ${c.name} answered only "unknown tool": ${direct.text}`)
        .not.toMatch(/unknown tool/i)
      expect(direct.text, `the answer to ${c.name} does not name the gateway to use instead: ${direct.text}`)
        .toContain('plur_admin')
      const named = direct.text.match(/action:\s*\\?"([a-z_]+)\\?"/)
      expect(named?.[1], `the answer to ${c.name} does not say which action to pass to plur_admin: ${direct.text}`)
        .toBe(c.name)

      // Follow the instruction literally.
      const followed = await s.call('plur_admin', { action: named![1], args: c.args })
      expect(followed.isError, `following the instruction failed: ${followed.text}`).toBe(false)
      expect(followed.json?.success, `following the instruction was refused: ${followed.text}`).not.toBe(false)
      if (c.name === 'plur_recall_hybrid') {
        const found = JSON.stringify(followed.json)
        expect(found, 'following the instruction did not run the real recall: the stored memory is missing').toContain('blue-green rollouts')
      }
    })
  }
})
