import {
  Plur,
  renderMemoryBlock,
  readProjectConfigFromPath,
  findProjectConfigPath,
  resolveProjectRemoteFromConfig,
  folderAskOnce,
  sessionSettings,
  type FolderPolicy,
  type ProjectRemote,
} from '@plur-ai/core'
// Type-only: the host contract is untyped at runtime — `@opencode-ai/plugin`
// is an optional peerDependency and this import must never become a runtime
// require. Typechecking the hook map against it turns a renamed/changed
// `experimental.` hook into a build failure instead of a silent no-op.
import type { Plugin, Hooks } from '@opencode-ai/plugin'
import { BlockCache } from './block.js'
import { RenderPath } from './capability.js'
import { TurnBuffer } from './turn.js'
import { learnFromTurn, learnFromUserText } from './learn.js'
import { OPENCODE_PLUGIN_VERSION } from './version.js'
import { resolveScopeRoot, resolveFolderDir, resolveTrustedScope, projectRemoteRefusalNotice, folderPolicy } from './scope.js'
import { INJECT_TIMEOUT_MS } from './timeout.js'
import { folderAskReminder, plurOnPath, PLUR_CLI_MISSING } from './ask.js'

const log = (msg: string) => { if (process.env.PLUR_DEBUG) console.error(`[plur:opencode] ${msg}`) }
// Unconditional — unlike `log` above. A `.plur.yaml` scope the plugin refuses
// to adopt (untrusted directory, D2) is exactly the kind of thing a user
// needs to see without having to already know to set PLUR_DEBUG=1 first.
const warn = (msg: string) => { console.error(`[plur:opencode] warning: ${msg}`) }


function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer) })
}
const TIMED_OUT = Symbol('timed-out')

/** Never let a memory failure break the agent's turn. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (err) { log(`${label} failed: ${(err as Error).message}`) }
}

export const PlurPlugin: Plugin = async (ctx) => {
  const scopeRoot = resolveScopeRoot(ctx ?? {})
  // The folder-map decision, the folder asked about and the .plur.yaml read
  // are all for the folder opencode is open in (audit F1 of #1517).
  const folderDir = resolveFolderDir(ctx ?? {})
  // `_plur` is a test-only injection seam, not part of the host contract —
  // narrowly typed here rather than widening `ctx` itself.
  //
  // `autoDiscover: false` (D1, 2026-09 audit): the default constructor
  // behaviour walks `cwd` looking for a `.plur/engrams.yaml` and, if found,
  // registers it as a STORE in the user's GLOBAL `~/.plur/config.yaml` —
  // silently (a `logger.info` suppressed at the default `warning`
  // threshold), permanently (it outlives the session and is read by every
  // other PLUR adapter too), and with the scope the discovered file's own
  // `.plur.yaml` names, including `global`. `cwd` here is the session's git
  // root — exactly where a cloned, hostile repo would ship both files. A
  // plugin loaded into someone else's agent host must not perform a
  // cwd-derived disk side effect that writes the user's global config as a
  // side effect of merely being loaded.
  //
  // The construction below is wrapped (D7, 2026-09 audit):
  // this whole block sits BEFORE the plugin has returned its hook map, so
  // there is no `safe()` wrapper reachable yet, and `new Plur()` can throw
  // (e.g. a hostile `.plur.yaml` naming a scope that collides with one the
  // user already registered — proofD). A throw here used to reject this
  // factory's promise, which fails opencode's PLUGIN LOAD, not just memory —
  // the whole host degrades because its memory layer couldn't build. Catch
  // it and return an all-no-op hook map instead: no memory this session,
  // but the agent's turn is never at risk. The folder decision and the
  // `.plur.yaml` read are no longer done here: they run per turn in
  // `folderState()`, inside each hook's `safe()` (#1347).
  let plur: Plur
  try {
    plur = (ctx as { _plur?: Plur })?._plur
      ?? new Plur({ path: process.env.PLUR_PATH, cwd: scopeRoot, autoDiscover: false })
  } catch (err) {
    warn(`memory layer failed to initialize — running this session with no memory: ${(err as Error).message}`)
    return {} satisfies Hooks
  }
  log(`scope root: ${scopeRoot}`)

  // Warnings about the repo's own settings are printed once per plugin
  // instance, and only in a folder that is `on`: an `off` folder is silent,
  // and an `ask` folder's question already says what the repo requests.
  const warnedOnce = new Set<string>()
  const warnOnce = (msg: string) => { if (!warnedOnce.has(msg)) { warnedOnce.add(msg); warn(msg) } }

  /**
   * What this session does in its folder, resolved per turn so a decision
   * made mid-session (the user answering the folder question with
   * `plur folders set`) applies from the next prompt (#1347):
   *
   *  - `off` → nothing: no recall, no question, no learning;
   *  - `ask` → no memories; the first turn of each session carries the one
   *    question (see `chat.message` below);
   *  - `on`  → the session scope is the map's scope, else a TRUSTED
   *    `.plur.yaml`'s (the resolver decides both; a map scope beats the
   *    hint). That scope is also what makes core dial the team store.
   *
   * The `.plur.yaml` is read once here, from one resolved path (E5,
   * 2026-09 audit): its REMOTE settings (#1207) go through core's gate, the
   * one every adapter passes (#1196/#1198), and its domain is adopted only
   * when the policy came from that file and its directory is trusted — both
   * checked against this same read, so the file trust is checked against is
   * the file whose fields are adopted.
   */
  function folderState(): { policy: FolderPolicy; settings: { scope?: string; domain?: string }; remote: ProjectRemote | null } {
    const policy = folderPolicy(plur, folderDir, warnOnce)
    if (policy.mode !== 'on') return { policy, settings: {}, remote: null }
    const configPath = findProjectConfigPath(folderDir)
    const raw = readProjectConfigFromPath(configPath)
    // The `.plur.yaml` hints, trust-checked against this read (D2); warns
    // once when they are ignored because the map decided for an untrusted
    // repo. The scope is the resolver's (map scope, else the trusted hint);
    // the domain is the trusted hint's, and only when the policy came from
    // that `.plur.yaml` — the CLI hooks' rule (sessionSettings).
    const hinted = resolveTrustedScope(plur, raw, configPath, warnOnce)
    const settings = sessionSettings(policy, hinted)
    const remote = resolveProjectRemoteFromConfig(plur, raw, configPath)
    // Refusal is unconditional like the scope one: team memory that silently
    // never arrives is indistinguishable from a broken remote leg, which is
    // the failure #1198 was filed about.
    if (remote.refusedFrom) warnOnce(projectRemoteRefusalNotice(remote.refusedFrom, plur.storageRoot))
    // Host only, never the token.
    if (remote.remoteProject) log(`project remote: ${remote.remoteProject.url}`)
    if (settings.scope) log(`session scope: ${settings.scope}`)
    return { policy, settings, remote }
  }

  // Sessions already asked the folder question by THIS plugin instance. In
  // memory, not a temp-dir marker like the CLI hooks: a session resumed in a
  // new opencode process gets the question again with fresh nonces, since
  // the old ones were expired when the previous process ended (dispose), the
  // same outcome as the CLI's resume rule (#1347 option C).
  const asked = new Set<string>()
  const claimAsk = (sessionID: string) => {
    if (asked.has(sessionID)) return false
    asked.add(sessionID)
    return true
  }
  // The offer each undecided session was given (audit F2 of #1517): the full
  // question until it has reached the model once, then a reminder with the
  // same commands, until the folder is decided or the session ends.
  const offers = new Map<string, { question: string; reminder: string; delivered: boolean }>()
  // Sessions already told the plur CLI is missing (audit F8 of #1517).
  const cliMissingTold = new Set<string>()
  /** The full question has reached the model: later turns get the reminder. */
  const markDelivered = (sessionID: string, block: string) => {
    const offer = offers.get(sessionID)
    if (offer && block === offer.question) offer.delivered = true
  }
  /** End a session's folder nonces (#1378): they die with the session, or after core's TTL. */
  const endNonces = (sessionID: string | undefined) => {
    if (!sessionID || !asked.has(sessionID)) return
    try { plur.endFolderNonceSession(sessionID) } catch (e) { log(`ending folder nonces failed: ${(e as Error).message}`) }
  }

  const blocks = new BlockCache()
  const path = new RenderPath()
  const turns = new TurnBuffer()
  // Sessions whose CURRENT turn's block was already injected by the
  // chat.message fallback (formal R2, mcp#10): system.transform must not push
  // it again into the same request. Reset at the next chat.message.
  const fallbackInjected = new Set<string>()
  void OPENCODE_PLUGIN_VERSION

  return {
    // Recall trigger — once per user turn. Injects nothing under normal
    // operation: system.transform (below) is the rendering path, and a part
    // pushed here would persist into session history and accrete one stale
    // block per turn. The one exception is the RenderPath fallback below —
    // once a full turn has passed with system.transform never firing, this
    // DOES push a part, accepting the accretion because a working-but-
    // accreting path beats memory silently vanishing.
    'chat.message': async (input, output) => {
      await safe('chat.message', async () => {
        // Record this turn's user messageID so the event handler below can
        // exclude its parts from the turn buffer — message.part.updated
        // fires for the user's own submitted message too, not just the
        // assistant's streamed reply (confirmed against the real binary).
        turns.markUserMessage(input.sessionID, output.message?.id)
        fallbackInjected.delete(input.sessionID)

        const query = (output?.parts ?? [])
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text).join('\n')

        const state = folderState()
        // Decided (on or off): the offer, and its nonces, are done.
        if (state.policy.mode !== 'ask' && offers.delete(input.sessionID)) endNonces(input.sessionID)
        if (state.policy.mode === 'off') {
          blocks.clear(input.sessionID)
          return
        }
        if (state.policy.mode === 'ask') {
          // No memories, no learning. The first turn of the session carries
          // the one question — the same text, content rules and per-answer
          // nonces as the CLI hooks (core's folderAskOnce); later turns carry
          // nothing until the user decides.
          let offer = offers.get(input.sessionID)
          // The offered commands need the plur CLI (audit F8 of #1517): without
          // it, say so once per session and issue nothing; ask once it appears.
          const needsCli = state.policy.reason !== 'malformed-map' && state.policy.reason !== 'resolver-error'
          const cliMissing = !offer && needsCli && !plurOnPath()
          if (cliMissing) {
            if (!cliMissingTold.has(input.sessionID)) {
              cliMissingTold.add(input.sessionID)
              blocks.set(input.sessionID, PLUR_CLI_MISSING)
            } else blocks.clear(input.sessionID)
          } else if (!offer) {
            const question = folderAskOnce({
              dir: folderDir, policy: state.policy, sessionId: input.sessionID,
              root: plur.storageRoot, plur, prompt: query, claim: claimAsk,
              // Bound to this session (audit F5 of #1517): shell.env below tells
              // the agent's shell which session it is in.
              bindSession: true,
            })
            if (question) {
              offer = { question, reminder: folderAskReminder(question), delivered: false }
              offers.set(input.sessionID, offer)
            }
          }
          if (offer) blocks.set(input.sessionID, offer.delivered ? offer.reminder : offer.question)
          else if (!cliMissing) blocks.clear(input.sessionID)
        } else {
          const { settings, remote } = state
          const pending = plur.injectHybrid(query, {
            scope: settings.scope,
            // Without this the remote leg dials only when the session scope
            // happens to match a store already registered in the user's global
            // config — so an enterprise user following the documented
            // `plur init-remote` onboarding got local-only recall here while
            // every other adapter reached their team store (#1207).
            ...(remote?.remoteProject ? { remote_project: remote.remoteProject } : {}),
          })
          pending.catch(() => {}) // a late rejection after the timeout must not go unhandled
          const injection = await withTimeout(pending, INJECT_TIMEOUT_MS)
          if (injection === TIMED_OUT) {
            // No memory this turn rather than the previous turn's block, which
            // answered a different query.
            blocks.clear(input.sessionID)
            warn(`recall took longer than ${INJECT_TIMEOUT_MS} ms — continuing this turn without memory`)
          } else {
            blocks.set(input.sessionID, renderMemoryBlock({ injection }))
            log(`recall for ${input.sessionID}: ${injection?.count ?? 0} engrams`)
          }

          // Secondary learning path: corrections/preferences from the user's
          // own text — the same text the recall query above was built from.
          // Fire-and-forget: never stall the turn on a slow store.
          void learnFromUserText(plur, query, settings).catch((e) =>
            log(`learn (user) failed: ${(e as Error).message}`))
        }

        // Safety net: system.transform is the preferred, non-accreting path.
        // If a full turn has gone by without it firing (see RenderPath),
        // opencode no longer supports it — fall back to injecting here so
        // memory keeps working instead of silently vanishing.
        if (path.shouldFallback(input.sessionID)) {
          const block = blocks.get(input.sessionID)
          const messageID = input.messageID ?? output.message?.id
          if (block && typeof messageID === 'string') {
            output.parts.push({
              id: `prt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
              sessionID: input.sessionID,
              messageID,
              type: 'text',
              text: block,
              synthetic: true,
            })
            fallbackInjected.add(input.sessionID)
            markDelivered(input.sessionID, block)
            log('system.transform unavailable — using chat.message fallback (accretes)')
          } else if (block) {
            // Per the spec's Known Gotcha #1: a part with messageID undefined
            // gets the ENTIRE user message rejected by opencode
            // ("invalid user part before save"), and turn.ts's exclusion
            // check short-circuits on a falsy messageID — so it would also
            // get harvested as if it were the assistant's own text. Degrade
            // to no-injection rather than either of those.
            log('system.transform unavailable and no messageID resolved — skipping fallback injection')
          }
        }
      })
    },

    // Renderer — once per model request (3x in a tool-calling turn). O(1):
    // reads the cache, never recalls. `system` is rebuilt by the host each
    // request, so this never accumulates.
    'experimental.chat.system.transform': async (input, output) => {
      await safe('system.transform', async () => {
        const block = input.sessionID ? blocks.get(input.sessionID) : undefined
        // Already in this request via the fallback part: do not render twice.
        if (block && !fallbackInjected.has(input.sessionID!)) {
          output.system.push(block)
          markDelivered(input.sessionID!, block)
        }
        if (input.sessionID) path.markRendered(input.sessionID)
      })
    },

    // Turn accumulation + debounced self-report learning.
    event: async ({ event }) => {
      await safe('event', async () => {
        if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
          const part = event.properties.part
          // Cumulative snapshot per part id, latest wins — TurnBuffer.append
          // also excludes parts whose messageID is this session's recorded
          // user message (see markUserMessage above and turn.ts's docstring).
          turns.append(part.sessionID, part.id, part.messageID, part.text ?? '')
        }
        if (event.type === 'session.idle') {
          const sessionID = event.properties?.sessionID
          // markTurn() goes ONLY here. Calling it from chat.message would
          // latch the fallback on turn one of every session, before
          // system.transform has had any chance to render at all.
          path.markTurn(sessionID)
          const texts = turns.takeIfFresh(sessionID)
          if (!texts) return
          // Auto-capture only where the folder is on (#1347).
          const state = folderState()
          if (state.policy.mode !== 'on') return
          // Fire-and-forget: never stall the turn on a slow store. One-shot
          // takeIfFresh already guards against session.idle's double-fire —
          // this only runs once per turn.
          void learnFromTurn(plur, texts, state.settings).catch((e) =>
            log(`learn (turn) failed: ${(e as Error).message}`))
        }
        if (event.type === 'session.deleted') {
          const sessionID = event.properties?.info?.id
          blocks.clear(sessionID)
          turns.clear(sessionID)
          path.clear(sessionID)
          fallbackInjected.delete(sessionID)
          endNonces(sessionID)
          asked.delete(sessionID)
          offers.delete(sessionID)
          cliMissingTold.delete(sessionID)
        }
      })
    },

    // Context is about to be dropped. Carry memory across the cut, and learn
    // from what is being discarded. Never set `output.prompt` — that replaces
    // the host's compaction prompt entirely.
    'experimental.session.compacting': async (input, output) => {
      await safe('compacting', async () => {
        const texts = turns.takeIfFresh(input.sessionID)
        // Memory crosses the cut, and what is dropped is learned, only where
        // the folder is on (#1347): an ask folder's block is the question,
        // which must not outlive its turn.
        const state = folderState()
        if (state.policy.mode !== 'on') return
        const block = blocks.get(input.sessionID)
        if (block) output.context.push(block)
        if (texts) void learnFromTurn(plur, texts, state.settings).catch((e) =>
          log(`learn (compacting) failed: ${(e as Error).message}`))
      })
    },

    // Tells every shell the agent runs which session it belongs to, so
    // `plur folders set --nonce` accepts this session's nonces and refuses
    // another session's (audit F5 of #1517). opencode's bash tool calls this
    // hook with the session id (checked against 1.18.33).
    'shell.env': async (input, output) => {
      await safe('shell.env', async () => {
        if (input?.sessionID) output.env.PLUR_FOLDER_SESSION = input.sessionID
      })
    },

    dispose: async () => {
      await safe('dispose', async () => {
        blocks.clearAll()
        // The process is going away: the question's nonces go with it.
        for (const sessionID of [...asked]) endNonces(sessionID)
        asked.clear()
        offers.clear()
        cliMissingTold.clear()
      })
    },
  } satisfies Hooks
}

export default PlurPlugin
