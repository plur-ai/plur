/**
 * What an inject tool reports as given is in its reply.
 *
 * `plur_inject` and `plur_inject_hybrid` listed every selected id in
 * `injected_ids` (and the store recorded every one of them as injected) while
 * the reply carried only the directives and consider sections. A pinned
 * prohibition — routed to constraints — was reported as given and never
 * reached the agent, and the usage receipt counted it as retrieved.
 *
 * For every id a reply lists, the reply text must carry that memory's entry
 * with its full statement and the scope it was saved in; and the receipt must
 * count exactly the memories the replies carried.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const TASK = 'deploy the billing service'
const SCOPE = 'project:reply-delivery'
const RULE = 'Never deploy billing on Fridays without a rollback plan'
const PLAIN = 'Deploy billing with blue-green rollouts and a smoke test'
const LONG = 'Billing deploy glossary: a cutover is the moment billing service traffic moves from the old deployment to the new one, '
  + 'and a rollback is the reverse move. '.repeat(8).trimEnd()

/** Every string the reply carries except the bare id lists. */
function replyText(reply: unknown): string {
  const out: string[] = []
  const walk = (v: unknown, key?: string): void => {
    if (key === 'injected_ids' || key === 'omitted_pinned') return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(x => walk(x))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(reply)
  return out.join('\n')
}

/** The "[id]" line plus its indented continuation lines. */
function entryFor(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.includes(`[${id}]`))
  if (start < 0) return ''
  const block = [lines[start]]
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*\[/.test(lines[i]); i++) block.push(lines[i])
  return block.join('\n')
}

describe('inject tool replies deliver what they report as given', () => {
  let plur: Plur
  let dir: string
  const tools = getToolDefinitions('full')
  const call = async (name: string, args: Record<string, unknown>) =>
    tools.find(t => t.name === name)!.handler(args, plur) as Promise<any>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-reply-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  for (const tool of ['plur_inject', 'plur_inject_hybrid']) {
    it(`${tool}: every listed id has its full statement and scope in the reply, incl. a pinned constraint`, async () => {
      const statements = new Map<string, string>()
      const rule = await plur.learn(RULE, { scope: SCOPE, pinned: true })
      statements.set(rule.id, RULE)
      statements.set((await plur.learn(PLAIN, { scope: SCOPE })).id, PLAIN)
      const long = await plur.learn(LONG, { scope: SCOPE, type: 'terminological' })
      statements.set(long.id, LONG)

      const res = await call(tool, { task: TASK, scope: SCOPE, budget: 4000, session_id: 's1' })
      const ids: string[] = res.injected_ids
      expect(ids).toContain(rule.id)
      expect(ids).toContain(long.id)
      expect(ids.length).toBe(res.count)

      const text = replyText(res)
      for (const id of ids) {
        const entry = entryFor(text, id)
        expect(entry, `${id} is listed as given but has no entry in the reply`).not.toBe('')
        expect(entry, `${id}: the entry does not carry the full statement`).toContain(statements.get(id)!)
        expect(entry.replace(statements.get(id)!, ''), `${id}: the entry does not name its scope`).toContain(SCOPE)
      }

      // The receipt counts what the reply carried — here, every listed id.
      const receipt = await plur.receipt({ days: 7, now: new Date(Date.now() + 60_000) })
      expect(receipt.retrieved.engrams).toBe(ids.length)
      expect(receipt.retrieved.engram_session_pairs).toBe(ids.length)
    })
  }
})
