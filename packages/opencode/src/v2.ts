import type { Plugin } from '@opencode/plugin'
import { resolve } from 'node:path'
import {
  Plur, allowBackgroundModelLoad, renderMemoryBlock, folderAskOnce,
  findProjectConfigPath, readProjectConfigFromPath, resolveProjectRemoteFromConfig,
  sessionSettings, skippedStoreNotice, loadConfig,
} from '@plur-ai/core'
import { folderPolicy, resolveTrustedScope, projectRemoteRefusalNotice } from './scope.js'
import { learnFromTurn, learnFromUserText } from './learn.js'
import { folderAskReminder, plurOnPath, PLUR_CLI_MISSING } from './ask.js'
import { INJECT_TIMEOUT_MS } from './timeout.js'

type Context = Plugin.Context
type ID = Parameters<Context['session']['get']>[0]['sessionID']
type Offer = { question: string; reminder: string; delivered: number; unreadable: boolean }
type State = {
  id: ID; folder: string; plur: Plur; seen: Set<string>; fingerprint: string
  cacheKey: string; block: string; offer?: Offer; asked: boolean; cliMissing: boolean
  texts: Map<string, string>; steps: Set<string>; activatedAt: number; jobs: Promise<void>; epoch: number
}
const debug = (e: unknown) => { if (process.env.PLUR_DEBUG) console.error('[plur:opencode]', String(e)) }

/** Native V2 host adapter. No pre-admission prompt hook and no synthetic history. */
export const setupV2: Plugin.Plugin['setup'] = async ctx => {
  const states = new Map<ID, State>()
  const locks = new Map<ID, Promise<unknown>>()
  const warnings = new Set<string>()
  const pendingRecall = new Set<Promise<unknown>>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const stop = new AbortController()
  let closing = false
  let cleanup: Promise<void> | undefined
  let reading: Promise<void> = Promise.resolve()
  const warn = (text: string) => {
    if (!warnings.has(text)) { warnings.add(text); console.error(`[plur:opencode] warning: ${text}`) }
  }
  const storageKey = (id: ID) => `sessions/${id}/processed-v2`
  const endNonces = (s: State) => {
    if (s.asked) { try { s.plur.endFolderNonceSession(s.id) } catch (e) { debug(e) } }
  }
  const serial = <T>(id: ID, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.catch(debug).then(fn)
    locks.set(id, next)
    void next.finally(() => { if (locks.get(id) === next) locks.delete(id) }).catch(debug)
    return next
  }
  const folder = async (id: ID): Promise<string> => {
    const info = await ctx.session.get({ sessionID: id })
    if (!info.location.directory) throw Error('Session has no local directory')
    return resolve(info.location.directory, info.subpath ?? '.')
  }
  const policy = (s: State) => {
    const decision = folderPolicy(s.plur, s.folder, warn)
    let settings: { scope?: string; domain?: string } = {}
    let remote: ReturnType<typeof resolveProjectRemoteFromConfig> | undefined
    if (decision.mode === 'on') {
      const path = findProjectConfigPath(s.folder)
      const raw = readProjectConfigFromPath(path)
      settings = sessionSettings(decision, resolveTrustedScope(s.plur, raw, path, warn))
      remote = resolveProjectRemoteFromConfig(s.plur, raw, path)
      if (remote.refusedFrom) warn(projectRemoteRefusalNotice(remote.refusedFrom, s.plur.storageRoot))
    }
    const autoLearn = loadConfig(resolve(s.plur.storageRoot, 'config.yaml')).auto_learn
    return { decision, settings, remote, autoLearn,
      fingerprint: JSON.stringify([s.folder, decision, settings, remote, autoLearn]) }
  }
  const invalidate = (s: State) => {
    s.epoch++; s.cacheKey = ''; s.block = ''; s.texts.clear(); s.steps.clear(); s.activatedAt = Date.now()
    endNonces(s); s.offer = undefined; s.asked = false; s.cliMissing = false
  }
  const current = async (s: State, fingerprint: string, epoch: number) =>
    states.get(s.id) === s && s.epoch === epoch && await folder(s.id) === s.folder && policy(s).fingerprint === fingerprint
  const persist = (s: State) => ctx.storage.set(storageKey(s.id), [...s.seen])
  const state = async (id: ID): Promise<State> => {
    const dir = await folder(id)
    let s = states.get(id)
    if (s && s.folder !== dir) {
      invalidate(s)
      await s.jobs
      s.plur.close()
      states.delete(id); s = undefined
    }
    if (!s) {
      // Host storage contains identifiers only, never conversation text.
      const saved = await ctx.storage.get(storageKey(id))
      const seen = new Set(Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string') : [])
      const plur = new Plur({ path: process.env.PLUR_PATH, cwd: dir, autoDiscover: false })
      s = { id, folder: dir, plur, seen, fingerprint: '', cacheKey: '', block: '', asked: false,
        cliMissing: false, texts: new Map(), steps: new Set(), activatedAt: Date.now(), jobs: Promise.resolve(), epoch: 0 }
      states.set(id, s)
    }
    return s
  }
  const queueLearning = (s: State, ids: string[], texts: string[], kind: 'user' | 'assistant', p = policy(s), epoch = s.epoch) => {
    if (p.decision.mode !== 'on') return
    // Serialize writes separately: a remote write must not delay the host's context hook.
    s.jobs = s.jobs.catch(debug).then(async () => {
      if (!await current(s, p.fingerprint, epoch)) { debug('learning skipped: changed session policy'); return }
      // The extraction helpers can produce several writes. Recheck every one,
      // including after an earlier write awaited a slow store.
      const guarded = {
        config: { auto_learn: p.autoLearn },
        async learnRouted(...args: Parameters<Plur['learnRouted']>) {
          if (!await current(s, p.fingerprint, epoch)) throw Error('Session policy changed during learning')
          return s.plur.learnRouted(...args)
        },
      }
      if (kind === 'user') {
        for (const text of texts) await learnFromUserText(guarded, text, p.settings)
      } else await learnFromTurn(guarded, texts, p.settings)
      // IDs are persisted before cleanup resolves. This is normal-reload
      // deduplication, not a cross-store crash-atomic exactly-once guarantee.
      for (const id of ids) s.seen.add(id)
      await persist(s)
    }).catch(debug)
  }
  const recall = async (s: State, query: string, p: ReturnType<typeof policy>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = s.plur.injectHybrid(query, { scope: p.settings.scope,
      ...(p.remote?.remoteProject ? { remote_project: p.remote.remoteProject } : {}) })
    pendingRecall.add(pending)
    void pending.finally(() => pendingRecall.delete(pending)).catch(debug)
    try {
      const result = await Promise.race([pending,
        new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), INJECT_TIMEOUT_MS) })])
      const hint = skippedStoreNotice(s.plur, s.id, s.folder)
      if (!result) { warn(`recall exceeded ${INJECT_TIMEOUT_MS} ms; continuing without memory`); return hint ?? '' }
      const block = renderMemoryBlock({ injection: result })
      return [hint, block].filter(Boolean).join('\n\n')
    } finally { if (timer) clearTimeout(timer) }
  }
  const render = async (request: { sessionID: ID; system: Array<{ type: 'text'; text: string } | unknown> }, compaction: boolean) => {
    if (closing) return
    await serial(request.sessionID, async () => {
      if (closing) return
      const s = await state(request.sessionID)
      const p = policy(s)
      if (s.fingerprint !== p.fingerprint) { invalidate(s); s.fingerprint = p.fingerprint }
      if (compaction) {
        if (p.decision.mode === 'on' && s.block && await current(s, p.fingerprint, s.epoch)) {
          request.system.push({ type: 'text', text: s.block })
        }
        return
      }
      const history = await ctx.session.context({ sessionID: s.id })
      let move = -1
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].type === 'location-switched') { move = i; break }
      }
      const messages = history.slice(move + 1)
      // Only the current admitted batch is eligible at first observation.
      // Earlier history and pre-move prompts are never bulk-imported.
      let boundary = -1
      for (let i=0;i<messages.length;i++) {
        if (messages[i].type === 'assistant' || messages[i].type === 'location-switched') boundary = i
      }
      const users = messages.filter(m => m.type === 'user')
      const batch = messages.slice(boundary + 1).filter(m => m.type === 'user').filter(m => !s.seen.has(m.id))
      const observed = history.filter(m => m.type === 'user')
      const changed = observed.some(m => !s.seen.has(m.id))
      for (const m of observed) s.seen.add(m.id)
      // Mark even off/ask observations: enabling later must not harvest private history.
      if (changed) await persist(s)
      if (p.decision.mode === 'off') { s.block = ''; return }
      const latest = users.at(-1)
      const key = latest?.id ?? ''
      const query = latest?.text ?? ''
      if (key !== s.cacheKey || !s.cacheKey) {
        s.cacheKey = key
        if (p.decision.mode === 'ask') {
          const unreadable = p.decision.reason === 'malformed-map' || p.decision.reason === 'resolver-error'
          if (s.offer && s.offer.unreadable !== unreadable) { endNonces(s); s.offer = undefined; s.asked = false }
          if (!s.offer && !unreadable && !plurOnPath()) {
            s.block = s.cliMissing ? '' : PLUR_CLI_MISSING; s.cliMissing = true
          } else {
            if (!s.offer && !s.asked) {
              const question = folderAskOnce({ dir:s.folder,policy:p.decision,sessionId:s.id,root:s.plur.storageRoot,
                plur:s.plur,prompt:query,claim:()=>{if(s.asked)return false;s.asked=true;return true},
                bindSession:true,commandSession:true,host:{pid:process.pid,startedAt:Date.now()-process.uptime()*1000} })
              if(question)s.offer={question,reminder:folderAskReminder(question),delivered:0,unreadable}
            }
            const offer=s.offer
            s.block=offer ? offer.delivered===0 ? offer.question : offer.delivered===1 ? offer.reminder : '' : ''
            if(offer && ++offer.delivered===3)endNonces(s)
          }
        } else {
          s.block = await recall(s, query, p)
        }
      }
      if (batch.length) queueLearning(s, batch.map(m=>m.id), batch.map(m=>m.text), 'user', p)
      // Recall and storage calls awaited above; a live move or switch-off may
      // have happened meanwhile. Never render the stale block into that request.
      if (s.block && await current(s,p.fingerprint,s.epoch)) request.system.push({type:'text',text:s.block})
      else s.block=''
    }).catch(debug)
  }
  const handle = async (event: { type: string; data: unknown }) => {
    const data = event.data as { sessionID?: ID; assistantMessageID?: string; ordinal?: number; text?: string; started?: number }
    const id = data?.sessionID
    if (!id || !states.has(id) || closing) return
    await serial(id, async () => {
      const s=states.get(id); if(!s)return
      if(event.type==='session.deleted') {
        invalidate(s); await s.jobs; s.plur.close(); states.delete(id); await ctx.storage.remove(storageKey(id)); return
      }
      if(event.type==='session.moved') { invalidate(s); return }
      if(event.type==='session.execution.failed' || event.type==='session.execution.interrupted') {s.texts.clear();s.steps.clear();return}
      const p = policy(s)
      if(await folder(id)!==s.folder || p.fingerprint!==s.fingerprint) {invalidate(s);return}
      if(p.decision.mode !== 'on') {s.texts.clear();s.steps.clear();return}
      // A completed text event may arrive after a folder/scope switch. Only
      // accept steps begun under this policy; delayed old starts are excluded too.
      if(event.type==='session.step.started' && data.assistantMessageID && typeof data.started==='number' && data.started >= s.activatedAt) {
        s.steps.add(data.assistantMessageID)
      }
      if(event.type==='session.text.ended' && typeof data.text==='string' && data.assistantMessageID && s.steps.has(data.assistantMessageID) && Number.isInteger(data.ordinal)) {
        s.texts.set(`assistant:${data.assistantMessageID}:${data.ordinal}`,data.text)
      }
      if(event.type==='session.execution.succeeded') {
        const parts=[...s.texts].filter(([key])=>!s.seen.has(key));s.texts.clear();s.steps.clear()
        if(parts.length) {
          for(const [key] of parts)s.seen.add(key)
          queueLearning(s,parts.map(([key])=>key),parts.map(([,text])=>text),'assistant')
        }
      }
    }).catch(debug)
  }
  const dispose = () => cleanup ??= (async () => {
    closing=true;stop.abort()
    await reading
    await Promise.allSettled([...locks.values()])
    await Promise.allSettled([...states.values()].map(s=>s.jobs))
    await Promise.allSettled([...pendingRecall])
    for(const s of states.values()){endNonces(s);s.plur.close()}
    states.clear()
    await Promise.allSettled(registrations.map(r=>r.dispose()))
  })()
  try {
    allowBackgroundModelLoad(true)
    registrations.push(await ctx.session.hook('context', r=>render(r,false)))
    registrations.push(await ctx.session.hook('compaction', r=>render(r,true)))
    reading=(async()=>{
      try {for await(const event of ctx.event.subscribe({signal:stop.signal}))await handle(event)}
      catch(e){if(!stop.signal.aborted)warn(`event subscription stopped: ${String(e)}`)}
    })()
    return dispose
  } catch(e) {debug(e);await dispose();return dispose}
}
