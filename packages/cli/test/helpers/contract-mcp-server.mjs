import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
if (process.argv.includes('--version')) { console.log(process.env.FIXTURE_VERSION); process.exit(0) }
const server = process.env.FIXTURE_SERVER
const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', async line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') return answer(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: process.env.FIXTURE_VERSION } })
  if (msg.method !== 'tools/call') return
  try {
    const config = yaml.load(readFileSync(process.env.FIXTURE_CONFIG, 'utf8'))
    const token = config.stores.find(s => s.url === server).token
    const tool = msg.params.name, args = msg.params.arguments
    const response = await fetch(server + (tool === 'plur_learn' ? '/api/v1/engrams' : '/api/v1/recall'), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    })
    if (!response.ok) throw new Error(`fixture server answered ${response.status}`)
    const body = await response.json()
    const results = process.env.FIXTURE_RECALL_MISS === '1' ? [] : body.results
    const value = tool === 'plur_learn' ? { ...body, delivery: 'remote', delivered_to: server }
      : { results, remote: { state: 'ok', hosts: [{ host: server, state: 'ok', ids: results.map(row => row.id) }] }, results_complete: true }
    answer(msg.id, { content: [{ type: 'text', text: JSON.stringify(value) }] })
  } catch { answer(msg.id, { isError: true, content: [{ type: 'text', text: 'fixture request failed' }] }) }
})
