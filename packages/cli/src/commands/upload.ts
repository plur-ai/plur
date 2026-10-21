import { formatSaveDestination, resolveScopeTarget, type Plur } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export const FLAGS = ['--yes', '--only']
export const FLAGS_WITH_VALUES = ['--only']

/** Init refreshes discovery before asking how many primary rows can be offered. */
export async function countUploadCandidates(plur: Plur, scopes: string[]): Promise<number> {
  const stores = (await plur.listStores()).map(store => ({ ...store }))
  const writable = scopes.filter(scope => {
    const target = resolveScopeTarget(scope, stores)
    return target.kind === 'remote' && target.writable
  })
  return (await plur.listUploadCandidates(writable)).filter(row => row.proposed !== null).length
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let yes = false, only: string[] | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') yes = true
    else if (args[i] === '--only' && only === undefined) {
      const value = args[++i]
      if (!value || value.split(',').some(id => !id.trim() || id.trim().startsWith('-'))) exit(1, '--only needs a comma-separated list of memory ids')
      only = [...new Set(value!.split(',').map(id => id.trim()))]
    } else exit(1, `Unknown upload argument: ${args[i]}`)
  }
  // Preview must not discover/register a project store or mutate primary rows.
  let plur: Plur, candidates: Awaited<ReturnType<Plur['listUploadCandidates']>>
  try {
    plur = createPlur(flags, { readonly: !yes, autoDiscover: false })
    const stores = (await plur.listStores()).map(store => ({ ...store }))
    const scopes = stores.filter(store => {
      const target = resolveScopeTarget(store.scope, stores)
      return target.kind === 'remote' && target.writable
    }).map(store => store.scope)
    candidates = await plur.listUploadCandidates(scopes)
  } catch {
    throw new Error('Could not read local upload candidates; check the primary store, configuration and folder policy')
  }
  if (only?.some(id => !candidates.some(row => row.id === id))) exit(1, '--only includes an id that is not an active primary-store memory')
  const proposals = candidates.filter(row => row.proposed !== null && (!only || only.includes(row.id)))
  const notSent = candidates.filter(row => !proposals.includes(row)).map(row => ({ id: row.id,
    reason: row.proposed === null ? 'stays local — no authorized scope' : 'not selected' }))
  const counts = { sent: 0, queued: 0, already_on_server: 0, held_for_review: 0, demoted_secret: 0, failed: 0 }
  const results = (yes ? (await plur.uploadLocal(proposals.map(row => row.id))).results : []).map(result => {
    const scope = candidates.find(row => row.id === result.id)!.scope
    const destination = result.outcome === 'held_for_review' ? `received by ${scope} — held for review, not active yet`
      : result.outcome === 'failed' ? 'upload not confirmed — inspect the outbox before retrying'
      : formatSaveDestination({ scope, shared: true,
        delivery: result.outcome === 'queued' ? 'outbox' : result.outcome === 'demoted_secret' ? 'local' : 'remote',
        ...(result.outcome === 'demoted_secret' ? { localReason: 'sensitive content was kept local' } : {}),
      })
    return { ...result, destination }
  })
  for (const result of results) {
    counts[result.outcome]++
    if (result.outcome !== 'sent' && result.outcome !== 'already_on_server') {
      const reason = { queued: 'queued — not delivered yet', held_for_review: 'held for review — not active yet',
        demoted_secret: 'kept local — sensitive content', failed: 'failed — inspect the outbox before retrying' }[result.outcome]
      notSent.push({ id: result.id, reason })
    }
  }
  const summary = `${proposals.length} of ${candidates.length} memories can go to a team scope`
  if (shouldOutputJson(flags)) outputJson({ preview: !yes, summary, proposals, results, counts, not_sent: notSent })
  else {
    outputText(summary)
    for (const row of proposals) outputText(`${row.id} → ${row.proposed}: ${row.statement}`)
    for (const result of results) outputText(`${result.id}: ${result.destination}`)
    if (!yes) outputText('Preview only. Run plur upload --yes to send these memories; --only <id,…> limits the selection.')
    outputText(Object.entries(counts).map(([name, count]) => `${name}: ${count}`).join(', '))
    for (const row of notSent) outputText(`${row.id}: ${row.reason}`)
  }
  if (counts.failed) process.exitCode = 1
}
