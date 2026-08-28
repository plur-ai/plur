import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
const DIST = process.argv[2]
const transport = new StdioClientTransport({
  command: process.execPath, args: [DIST],
  env: { ...process.env, PLUR_TOOL_PROFILE: 'full' }, stderr: 'pipe',
})
const client = new Client({ name: 'gate2', version: '1' })
await client.connect(transport)
const pid = transport.pid ?? transport._process?.pid
let stderrAll = ''
transport.stderr?.on('data', d => { stderrAll += d.toString() })
console.log('child pid:', pid)
const t0 = Date.now()
try {
  const r = await client.callTool({ name: 'plur_session_start', arguments: { task: 'raw gate probe' } }, undefined, { timeout: 120000 })
  console.log(`OK in ${Date.now() - t0}ms, response chars:`, JSON.stringify(r).length)
} catch (e) {
  console.log(`FAILED in ${Date.now() - t0}ms:`, e.message)
  try { process.kill(pid, 0); console.log('child STILL ALIVE after failure') } catch { console.log('child DEAD after failure') }
}
console.log('stderr tail:', stderrAll.slice(-400).replace(/\n/g, ' | '))
await client.close().catch(() => {})
