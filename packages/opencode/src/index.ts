import {
  Plur,
  allowBackgroundModelLoad,
  renderMemoryBlock,
  readProjectConfigFromPath,
  findProjectConfigPath,
  resolveProjectRemoteFromConfig,
  folderAskOnce,
  sessionSettings,
  skippedStoreNotice,
  withDeadline,
  DEADLINE_MISSED,
  type FolderPolicy,
  type ProjectRemote,
} from '@plur-ai/core'
// Type-only: the host contract is untyped at runtime — `@opencode-ai/plugin`
// is an optional peerDependency and this import must never become a runtime
// require. Typechecking the hook map against it turns a renamed/changed
// `experimental.` hook into a build failure instead of a silent no-op.
import type { Plugin, Hooks } from '@opencode-ai/plugin'
import { setupV2 } from './v2.js'
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
// to adopt (untrusted directory) is exactly the kind of thing a user
// needs to see without having to already know to set PLUR_DEBUG=1 first.
const warn = (msg: string) => { console.error(`[plur:opencode] warning: ${msg}`) }



/** Turns after the question that still carry its commands. */
const REMINDER_TURNS = 1

/** Never let a memory failure break the agent's turn. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (err) { log(`${label} failed: ${(err as Error).message}`) }
}

export const PlurPlugin: Plugin = async (ctx) => {
  const scopeRoot = resolveScopeRoot(ctx ?? {})
  // The folder-map decision, the folder asked about and the .plur.yaml read
  // are all for the folder opencode is open in.
  const folderDir = resolveFolderDir(ctx ?? {})
  // `_plur` is a test-only injection seam, not part of the host contract.
  // `autoDiscover: false`: discovery would silently and permanently register a cwd
  // `.plur/engrams.yaml` in the user's GLOBAL config — a hostile cloned repo could ship it.
  // Construction is wrapped: no `safe()` exists yet, and a throw here would fail opencode's
  // plugin load. On failure return an all-no-op hook map. Folder decisions run per turn
  // in `folderState()`, inside `safe()`.
  let plur: Plur
  try {
    plur = (ctx as { _plur?: Plur })?._plur
      ?? new Plur({ path: process.env.PLUR_PATH, cwd: scopeRoot, autoDiscover: false })
  } catch (err) {
    warn(`memory layer failed to initialize — running this session with no memory: ${(err as Error).message}`)
    return {} satisfies Hooks
  }
  log(`scope root: ${scopeRoot}`)
  // Keep turns responsive, but do not let host shutdown discard accepted writes.
  const learning = new Set<Promise<void>>()
  const backgroundLearning = (job: Promise<void>, label: string) => {
    const pending = job.catch((e) => log(`learn (${label}) failed: ${(e as Error).message}`))
    learning.add(pending)
    void pending.then(() => learning.delete(pending))
  }

  // The plugin lives as long as the opencode process: when a recall finds the
  // embedding model missing, it may load it in the background, once.
  try { allowBackgroundModelLoad(true) } catch { /* optional */ }

  // Warnings about the repo's own settings are printed once per plugin
  // instance, and only in a folder that is `on`: an `off` folder is silent,
  // and an `ask` folder's question already says what the repo requests.
  const warnedOnce = new Set<string>()
  const warnOnce = (msg: string) => { if (!warnedOnce.has(msg)) { warnedOnce.add(msg); warn(msg) } }

  /**
   * What this session does in its folder, resolved per turn (so `plur folders set` applies
   * from the next prompt):
   *  - `off` → no recall, no question, no learning;
   *  - `ask` → no memories; the first turn asks once, the next reminds (`chat.message`);
   *  - `on`  → the map's scope, else a TRUSTED `.plur.yaml`'s; this scope dials the team store.
   * The `.plur.yaml` is read once: remote settings go through core's gate, and its domain is
   * adopted only from a trusted file — both checked against this same read.
   */
  function folderState(): { policy: FolderPolicy; settings: { scope?: string; domain?: string }; remote: ProjectRemote | null } {
    const policy = folderPolicy(plur, folderDir, warnOnce)
    if (policy.mode !== 'on') return { policy, settings: {}, remote: null }
    const configPath = findProjectConfigPath(folderDir)
    const raw = readProjectConfigFromPath(configPath)
    // The `.plur.yaml` hints, trust-checked against this read; warns
    // once when they are ignored because the map decided for an untrusted
    // repo. The scope is the resolver's (map scope, else the trusted hint);
    // the domain is the trusted hint's, and only when the policy came from
    // that `.plur.yaml` — the CLI hooks' rule (sessionSettings).
    const hinted = resolveTrustedScope(plur, raw, configPath, warnOnce)
    const settings = sessionSettings(policy, hinted)
    const remote = resolveProjectRemoteFromConfig(plur, raw, configPath)
    // Refusal is unconditional like the scope one: team memory that silently
    // never arrives is indistinguishable from a broken remote leg.
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
  // same outcome as the CLI's resume rule.
  const asked = new Set<string>()
  const claimAsk = (sessionID: string) => {
    if (asked.has(sessionID)) return false
    asked.add(sessionID)
    return true
  }
  // The offer each undecided session was given: the full
  // question until it has reached the model once, then one reminder with the
  // same commands on the next turn — the turn the user answers in — and then
  // nothing: the nonces are ended, so a later unrelated "yes"
  // cannot be run as consent. Delivered into history (the chat.message
  // fallback), the question stays there, so no reminder is pushed at all.
  // `unreadable`: the offer is the "map cannot be read" notice; when that
  // changes, the offer is rebuilt.
  type Offer = { question: string; reminder: string; unreadable: boolean; delivered: boolean; persisted: boolean; turnsSince: number }
  const offers = new Map<string, Offer>()
  // Sessions the "plur CLI is missing" notice has REACHED.
  const cliMissingTold = new Set<string>()
  /** A block reached the model: through system[] (`persisted` false) or as a history part. */
  const markDelivered = (sessionID: string, block: string, persisted: boolean) => {
    if (block === PLUR_CLI_MISSING) cliMissingTold.add(sessionID)
    const offer = offers.get(sessionID)
    if (offer && !offer.delivered && block === offer.question) {
      offer.delivered = true
      offer.persisted = persisted
    }
  }
  /** End a session's folder nonces: they die with the session, or after core's TTL. */
  const endNonces = (sessionID: string | undefined) => {
    if (!sessionID || !asked.has(sessionID)) return
    try { plur.endFolderNonceSession(sessionID) } catch (e) { log(`ending folder nonces failed: ${(e as Error).message}`) }
  }

  const blocks = new BlockCache()
  const path = new RenderPath()
  const turns = new TurnBuffer()
  // Sessions whose CURRENT turn's block was already injected by the
  // chat.message fallback: system.transform must not push
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
          // nonces as the CLI hooks (core's folderAskOnce); the next turn a
          // reminder of its commands; later turns nothing.
          const unreadable = state.policy.reason === 'malformed-map' || state.policy.reason === 'resolver-error'
          let offer = offers.get(input.sessionID)
          // The map became unreadable after the question, or readable again
          // after the notice: drop the old offer and its nonces.
          if (offer && offer.unreadable !== unreadable) {
            endNonces(input.sessionID)
            offers.delete(input.sessionID)
            asked.delete(input.sessionID)
            offer = undefined
          }
          // The offered commands need the plur CLI: without
          // it, say so once per session and issue nothing; ask once it appears.
          const cliMissing = !offer && !unreadable && !plurOnPath()
          if (cliMissing) {
            if (!cliMissingTold.has(input.sessionID)) blocks.set(input.sessionID, PLUR_CLI_MISSING)
            else blocks.clear(input.sessionID)
          } else if (!offer) {
            const question = folderAskOnce({
              dir: folderDir, policy: state.policy, sessionId: input.sessionID,
              root: plur.storageRoot, plur, prompt: query, claim: claimAsk,
              // Bound to this session: shell.env below tells
              // the agent's shell which session it is in.
              bindSession: true,
              // This opencode process asked: the PLUR MCP server it started
              // shows this question, not a second set of nonces. Its id and
              // start time, so a reused process id never passes for it.
              host: { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000 },
            })
            if (question) {
              offer = { question, reminder: folderAskReminder(question), unreadable, delivered: false, persisted: false, turnsSince: 0 }
              offers.set(input.sessionID, offer)
            }
          }
          if (!offer) {
            if (!cliMissing) blocks.clear(input.sessionID)
          } else if (!offer.delivered) {
            blocks.set(input.sessionID, offer.question)
          } else if (++offer.turnsSince <= REMINDER_TURNS) {
            // Fallback delivery left the question in history: nothing to add.
            if (offer.persisted) blocks.clear(input.sessionID)
            else blocks.set(input.sessionID, offer.reminder)
          } else {
            // Unanswered: the offer is over for this session.
            blocks.clear(input.sessionID)
            if (offer.turnsSince === REMINDER_TURNS + 1) endNonces(input.sessionID)
          }
        } else {
          const { settings, remote } = state
          const pending = plur.injectHybrid(query, {
            scope: settings.scope,
            // Without this the remote leg dials only when the session scope
            // happens to match a store already registered in the user's global
            // config, so a user onboarded with `plur init-remote` would get
            // local-only recall here while every other adapter reaches their
            // team store.
            ...(remote?.remoteProject ? { remote_project: remote.remoteProject } : {}),
          })
          pending.catch(() => {}) // a late rejection after the timeout must not go unhandled
          const injection = await withDeadline(pending, INJECT_TIMEOUT_MS)
          // A store in this folder that was found but not added: one
          // line, once per session and folder, like the CLI prompt hooks.
          const hint = skippedStoreNotice(plur, input.sessionID, folderDir)
          if (injection === DEADLINE_MISSED) {
            // No memory this turn rather than the previous turn's block, which
            // answered a different query.
            if (hint) blocks.set(input.sessionID, hint)
            else blocks.clear(input.sessionID)
            warn(`recall took longer than ${INJECT_TIMEOUT_MS} ms — continuing this turn without memory`)
          } else {
            const block = renderMemoryBlock({ injection })
            blocks.set(input.sessionID, hint ? (block ? `${hint}\n\n${block}` : hint) : block)
            log(`recall for ${input.sessionID}: ${injection?.count ?? 0} engrams`)
          }

          // Secondary learning path: corrections/preferences from the user's
          // own text — the same text the recall query above was built from.
          // Fire-and-forget: never stall the turn on a slow store.
          backgroundLearning(learnFromUserText(plur, query, settings), 'user')
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
            markDelivered(input.sessionID, block, true)
            log('system.transform unavailable — using chat.message fallback (accretes)')
          } else if (block) {
            // A part with messageID undefined
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
          markDelivered(input.sessionID!, block, false)
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
          // Auto-capture only where the folder is on.
          const state = folderState()
          if (state.policy.mode !== 'on') return
          // Fire-and-forget: never stall the turn on a slow store. One-shot
          // takeIfFresh already guards against session.idle's double-fire —
          // this only runs once per turn.
          backgroundLearning(learnFromTurn(plur, texts, state.settings), 'turn')
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
        // the folder is on: an ask folder's block is the question,
        // which must not outlive its turn.
        const state = folderState()
        if (state.policy.mode !== 'on') return
        const block = blocks.get(input.sessionID)
        if (block) output.context.push(block)
        if (texts) backgroundLearning(learnFromTurn(plur, texts, state.settings), 'compacting')
      })
    },

    // Tells every shell the agent runs which session it belongs to, so
    // `plur folders set --nonce` accepts this session's nonces and refuses
    // another session's. opencode's bash tool calls this
    // hook with the session id (checked against 1.18.33).
    'shell.env': async (input, output) => {
      await safe('shell.env', async () => {
        if (input?.sessionID) output.env.PLUR_FOLDER_SESSION = input.sessionID
      })
    },

    dispose: async () => {
      await safe('dispose', async () => {
        await Promise.allSettled([...learning])
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

// V1 >=1.18.0 selects server; V2 >=2.0.23 selects setup. SDK imports stay type-only.
export default { id: 'plur', server: PlurPlugin, setup: setupV2 }
