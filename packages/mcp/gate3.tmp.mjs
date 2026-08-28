import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
const LOG = '/private/tmp/claude-501/-Users-gregor-Data/5aee7ce8-5f37-41b4-a612-e78be2525d03/scratchpad/wrap-stderr.log'
const transport = new StdioClientTransport({
  command: '/bin/sh',
  args: ['-c', `exec "${process.execPath}" wrap-entry.tmp.mjs 2>>"${LOG}"`],
  env: { ...process.env, PLUR_TOOL_PROFILE: 'full' },
})
const client = new Client({ name: 'gate3', version: '1' })
await client.connect(transport)
const t0 = Date.now()
try {
  const r = await client.callTool({ name: 'plur_session_start', arguments: { task: '0.19.1 gate verification round X' } }, undefined, { timeout: 120000 })
  console.log(`OK in ${Date.now() - t0}ms chars=${JSON.stringify(r).length}`)
} catch (e) {
  console.log(`FAILED in ${Date.now() - t0}ms: ${e.message}`)
}
await client.close().catch(() => {})
