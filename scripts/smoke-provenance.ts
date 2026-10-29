/**
 * Provenance smoke test, end to end against a real provenance gateway.
 *
 *   pnpm -r build && npx tsx scripts/smoke-provenance.ts
 *
 * Each scene is one claim the explainer (storyboard in plur-space: content/provenance-explainer/storyboard.md) makes,
 * checked the way a viewer would see it: through the MCP tools an agent calls
 * and the `plur` commands a person types. Nothing is mocked; the session list
 * is stored on Swarm through the gateway and read back by reference.
 *
 * Environment:
 *   PLUR_SMOKE_GATEWAY   gateway URL (default: PLUR's default gateway)
 *   PLUR_SMOKE_STAMP     a postage stamp (batch id) to upload with; without it
 *                        the gateway's free tier gives a stamp good for ~a day
 *   PLUR_SMOKE_NOTARY    the notary address to pin (default: PLUR's known one
 *                        for the default gateway)
 *   PLUR_SMOKE_KEEP=1    keep the temporary stores for inspection
 *
 * Exit 0 when every scene holds, 1 when one does not, 2 when the gateway could
 * not be reached at all (nothing was checked).
 */
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '../packages/mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import { StdioClientTransport } from '../packages/mcp/node_modules/@modelcontextprotocol/client/dist/stdio.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'packages/cli/dist/index.js')
const MCP = join(ROOT, 'packages/mcp/dist/index.js')
const GATEWAY = process.env.PLUR_SMOKE_GATEWAY || 'https://provenance-gateway.datafund.io'
const STAMP = process.env.PLUR_SMOKE_STAMP || ''
// A downloaded list must be signed by a notary the verifier names itself:
// pinned here, or for the default gateway its known notary (0.23 review, finding 9).
const NOTARY_ARGS = process.env.PLUR_SMOKE_NOTARY ? ['--notary', process.env.PLUR_SMOKE_NOTARY] : []
const RUN = `smoke-${Date.now().toString(36)}`

const temps: string[] = []
function tempStore(name: string, config: string): string {
  const dir = mkdtempSync(join(tmpdir(), `plur-${name}-`))
  temps.push(dir)
  writeFileSync(join(dir, 'config.yaml'), config)
  writeFileSync(join(dir, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(process.cwd())}\n    plur: on\n`)
  return dir
}

let failures = 0
function scene(n: number, title: string, says: string): void {
  console.log(`\n── Scene ${n}: ${title}\n   "${says}"`)
}
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function plur(store: string, args: string[]): { code: number; json: any; text: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { env: { ...process.env, PLUR_PATH: store }, encoding: 'utf8', timeout: 120_000 })
  let json: any = null
  try { json = JSON.parse(r.stdout) } catch { /* text output */ }
  return { code: r.status ?? -1, json, text: (r.stdout || '') + (r.stderr || '') }
}

/** The real MCP server, as an agent's client starts it: the built binary over stdio. */
async function mcp(store: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    cwd: process.cwd(),
    env: { ...process.env, PLUR_PATH: store } as Record<string, string>,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'provenance-smoke', version: '1.0.0' })
  await client.connect(transport)
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const res: any = await client.callTool({ name, arguments: args })
      const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n')
      let json: any = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return { isError: res.isError === true, text, json }
    },
    close: () => client.close().catch(() => undefined),
  }
}

async function main(): Promise<number> {
  if (!existsSync(CLI) || !existsSync(MCP)) { console.error('build first: pnpm -r build'); return 2 }
  console.log(`Provenance smoke ${RUN}\n  gateway: ${GATEWAY}\n  stamp:   ${STAMP || '(free tier, ~1 day)'}`)
  try {
    const h = await fetch(GATEWAY.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(15_000) })
    console.log(`  gateway health: HTTP ${h.status} ${(await h.text()).slice(0, 200).replace(/\s+/g, ' ')}`)
  } catch (err) {
    console.error(`  the gateway could not be reached: ${(err as Error).message}`)
    return 2
  }

  const receipts = `receipts:\n  store: swarm\n  gateway_url: ${GATEWAY}\n${STAMP ? `  stamp_id: ${STAMP}\n` : ''}`
  const agent = tempStore('agent', `backend: yaml\nprovenance:\n  identity: agent:${RUN}\n${receipts}`)

  // ── 1 ────────────────────────────────────────────────────────────────────
  scene(1, 'An agent works with its memory',
    'Your agent starts a session with what it already knows, looks things up, and learns something new.')
  const a = await mcp(agent)
  const known = await a.call('plur_learn', { statement: `Release notes for ${RUN} are written in plain language`, scope: 'global', rationale: 'customers read them' })
  const looked = await a.call('plur_learn', { statement: `The ${RUN} deploy window is Tuesday afternoon`, scope: 'global' })
  const start = await a.call('plur_session_start', { task: `write the ${RUN} release notes in plain language` })
  const session = start.json?.session_id as string
  check(!!session, 'a session started', session)
  const recall = await a.call('plur_recall', { query: `${RUN} deploy window`, session_id: session })
  check(!recall.isError, 'the agent looked something up')
  const saved = await a.call('plur_learn', { statement: `For ${RUN}, lead with what changed for the customer`, scope: 'global', session_id: session, rationale: 'agreed in review' })
  const savedId = saved.json?.id as string
  check(!!savedId, 'the agent saved a new memory', savedId)

  // ── 2 ────────────────────────────────────────────────────────────────────
  scene(2, 'The session ends; its memory list is stored on Swarm',
    'When the session ends, PLUR stores the list of memories the agent had — fingerprints, never text — on Swarm, and a notary signs it.')
  const end = await a.call('plur_session_end', { summary: `Wrote the ${RUN} release notes.`, engram_suggestions: [], session_id: session })
  await a.close()
  const anchor = end.json?.anchor
  check(!end.isError, 'session end succeeded', end.isError ? end.text.slice(0, 200) : '')
  check(!anchor?.error, 'the upload succeeded', anchor?.error ?? '')
  const ref = anchor?.reference as string
  check(/^[0-9a-f]{64}$/.test(ref ?? ''), 'a Swarm reference came back', ref)
  check(!!anchor?.notary, 'the gateway notary signed it', anchor?.notary ?? '')
  check(typeof anchor?.stored_until === 'string', 'it says how long the proof stays stored', anchor?.stored_until ?? 'not reported')
  if (!ref) return 1

  const doc = await (await fetch(`${GATEWAY.replace(/\/+$/, '')}/api/v1/data/${ref}`)).json() as any
  const stored = Buffer.from(String(doc.data ?? doc.metadata?.data ?? ''), 'base64').toString('utf8')
  for (const t of [known, looked, saved]) {
    const id = t.json?.id
    check(!!id && stored.includes(id), `the stored list names ${id}`)
  }
  check(!stored.includes('plain language') && !stored.includes('Tuesday afternoon') && !stored.includes('customer'), 'the stored list carries no memory text')

  // ── 3 ────────────────────────────────────────────────────────────────────
  const auditor = tempStore('auditor', 'backend: yaml\n')
  cpSync(join(agent, 'engrams.yaml'), join(auditor, 'engrams.yaml'))
  cpSync(join(agent, 'history'), join(auditor, 'history'), { recursive: true })
  scene(3, 'Anyone with the reference can check it',
    'Weeks later someone asks what the agent knew. On another machine holding the same memories, one command fetches the list from Swarm, checks the notary signature, and checks every memory.')
  const v = plur(auditor, ['verify', '--manifest', ref, ...NOTARY_ARGS])
  check(v.code === 0 && v.json?.status === 'verified', 'verify by reference: OK (exit 0)', `exit ${v.code}`)
  check(v.json?.integrity?.notary?.signature_ok === true, 'the notary signature checks out', v.json?.integrity?.notary?.recovered ?? '')
  const roles = new Map<string, string>((v.json?.results ?? []).map((r: any) => [r.id, r.role]))
  check(roles.get(known.json?.id) === 'injected', 'it shows what the agent was given', roles.get(known.json?.id) ?? 'missing')
  check(roles.get(looked.json?.id) === 'recalled' || roles.get(looked.json?.id) === 'injected', 'it shows what the agent looked up', roles.get(looked.json?.id) ?? 'missing')
  check(roles.get(savedId) === 'written', 'it shows what the agent saved', roles.get(savedId) ?? 'missing')
  check((v.json?.results ?? []).every((r: any) => r.status === 'MATCH'), 'every memory still matches')

  // ── 4 ────────────────────────────────────────────────────────────────────
  scene(4, 'What happened with one memory',
    'Pick any memory on the list and PLUR shows where it came from: which session saved it, and its history since.')
  const prov = plur(auditor, ['provenance', savedId])
  check(prov.code === 0 && JSON.stringify(prov.json ?? prov.text).includes(session), 'its origin names the session that saved it', `exit ${prov.code}`)

  // ── 5 ────────────────────────────────────────────────────────────────────
  scene(5, 'A quiet edit is caught',
    'If someone later changes a memory — even only the reason behind it — the check says exactly which one changed.')
  const path = join(auditor, 'engrams.yaml')
  writeFileSync(path, readFileSync(path, 'utf8').replace('agreed in review', 'decided alone'))
  const v2 = plur(auditor, ['verify', '--manifest', ref, ...NOTARY_ARGS])
  const changed = (v2.json?.results ?? []).filter((r: any) => r.status === 'CHANGED').map((r: any) => r.id)
  check(v2.code === 1, 'verify says changed (exit 1)', `exit ${v2.code}`)
  check(changed.length === 1 && changed[0] === savedId, 'only the edited memory is flagged', changed.join(', '))

  // ── 6 ────────────────────────────────────────────────────────────────────
  scene(6, 'Rewriting history is caught',
    "PLUR's own history is a hash chain. Edit it behind PLUR's back and the check says where it broke.")
  const hdir = join(agent, 'history')
  const month = readdirSync(hdir).filter(f => f.endsWith('.jsonl')).sort()[0]
  const lines = readFileSync(join(hdir, month), 'utf8').split('\n')
  lines[0] = lines[0].replace(/"timestamp":"[^"]+"/, '"timestamp":"2020-01-01T00:00:00.000Z"')
  writeFileSync(join(hdir, month), lines.join('\n'))
  const h = plur(agent, ['verify'])
  check(h.code === 1, 'plur verify: BROKEN (exit 1), with the place named', `exit ${h.code} ${JSON.stringify(h.json?.breaks?.[0] ?? '').slice(0, 120)}`)

  // ── 7 ────────────────────────────────────────────────────────────────────
  scene(7, 'Off by default',
    'Nothing leaves your machine unless you turn Swarm storage on.')
  const quiet = tempStore('quiet', 'backend: yaml\n')
  const q = await mcp(quiet)
  const qs = await q.call('plur_session_start', { task: 'a session with storage off' })
  await q.call('plur_learn', { statement: `Off-by-default check ${RUN}`, scope: 'global', session_id: qs.json?.session_id })
  const qe = await q.call('plur_session_end', { summary: 'done', engram_suggestions: [], session_id: qs.json?.session_id })
  await q.close()
  check(!qe.isError && qe.json?.anchor === undefined && !existsSync(join(quiet, 'receipts')), 'no upload, no receipt')

  // ── 8 ────────────────────────────────────────────────────────────────────
  scene(8, 'A store that does not hold the memories cannot vouch for them',
    'Checking needs the memories themselves; a stranger with only the reference learns that it is signed, not what it says.')
  const stranger = tempStore('stranger', 'backend: yaml\n')
  const s = plur(stranger, ['verify', '--manifest', ref, ...NOTARY_ARGS])
  check(s.code === 2, 'verify elsewhere: cannot verify (exit 2), never OK', `exit ${s.code}`)

  return failures === 0 ? 0 : 1
}

main()
  .then(code => {
    console.log(`\n${failures === 0 && code === 0 ? 'ALL SCENES HOLD' : `${failures} check(s) failed`} (exit ${code})`)
    if (!process.env.PLUR_SMOKE_KEEP) for (const d of temps) rmSync(d, { recursive: true, force: true })
    else console.log(`kept: ${temps.join(' ')}`)
    process.exit(code)
  })
  .catch(err => { console.error(err); process.exit(1) })
