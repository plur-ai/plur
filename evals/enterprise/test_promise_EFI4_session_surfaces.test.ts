import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enterpriseFixture, sourceCli } from '../helpers/enterprise-install.js'
import { connectMcp, callTool } from '../helpers/privacy-folders-team-mcp.js'
let f: Awaited<ReturnType<typeof enterpriseFixture>> | undefined
afterEach(async () => { await f?.close() })
it.each([['claude', 'hook-inject'], ['codex', 'hook-codex-session-start'], ['cursor', 'hook-cursor-session-start']])(
  'EFI-4 %s session start names its destination and records that the hook really ran', async (tool, command) => {
    f = await enterpriseFixture(); const started = Date.now()
    const run = await sourceCli([command], { ...f.env, PLUR_REMOTE_RECALL: 'off' }, f.repo, JSON.stringify({
      cwd: f.repo, workspace_roots: [f.repo], session_id: 'promise-session', conversation_id: 'promise-session',
      source: 'startup', prompt: 'Review the deployment', hook_event_name: command === 'hook-inject' ? 'UserPromptSubmit' : 'SessionStart',
    }))
    expect(run.status, `The session-start command must complete: ${run.stderr}`).toBe(0)
    expect(run.stdout, 'The agent must see where this workspace saves').toContain('PLUR → server as fixture · saving to project:example/team/app')
    const at = Date.parse(JSON.parse(readFileSync(join(f.store, 'hook-runs.json'), 'utf8'))[tool])
    expect(at, 'The recorded hook run must belong to this actual invocation').toBeGreaterThanOrEqual(started)
    expect(at, 'The recorded hook run cannot be in the future').toBeLessThanOrEqual(Date.now())
  })
it('EFI-4 MCP session start exposes the same destination to its agent', async () => {
  f = await enterpriseFixture(); const p = f.open(), mcp = await connectMcp(p, { roots: [f.repo] })
  try {
    const result = await callTool(mcp.client, 'plur_session_start', { task: 'Review deployment readiness' })
    expect(result.raw.isError, 'Session start must succeed before its status can count').not.toBe(true)
    expect(result.json.server_status, 'MCP must expose the admitted workspace destination').toEqual(['PLUR → server as fixture · saving to project:example/team/app'])
    expect(result.json.guide, 'The destination must also appear in the agent-facing guide').toContain('saving to project:example/team/app')
  } finally { await mcp.close() }
})
