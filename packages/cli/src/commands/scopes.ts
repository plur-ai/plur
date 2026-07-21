import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const subcommand = args[0]

  if (subcommand === '--reoffer') {
    plur.reofferScopes()
    if (shouldOutputJson(flags)) {
      outputJson({ ok: true, action: 'reoffer' })
    } else {
      outputText('Dismissed scopes cleared — they will reappear next session.')
    }
    return
  }

  if (subcommand === 'dismiss') {
    const scope = args[1]
    if (!scope) exit(1, 'Usage: plur scopes dismiss <scope>')
    plur.dismissScope(scope)
    if (shouldOutputJson(flags)) {
      outputJson({ ok: true, action: 'dismiss', scope })
    } else {
      outputText(`Dismissed "${scope}" — it will no longer appear in session nudges. Run \`plur scopes --reoffer\` to undo.`)
    }
    return
  }

  if (subcommand === 'register') {
    const scope = args[1]
    if (!scope) exit(1, 'Usage: plur scopes register <scope>')
    const result = plur.registerScope(scope)
    if (shouldOutputJson(flags)) {
      outputJson({ ok: result.status !== 'skipped', ...result, scope })
    } else {
      if (result.status === 'added') {
        outputText(`Registered scope "${scope}".`)
      } else if (result.status === 'already_registered') {
        outputText(`Scope "${scope}" is already registered.`)
      } else {
        exit(1, `Could not register "${scope}": ${result.reason ?? 'unknown reason'}`)
      }
    }
    return
  }

  if (!subcommand || subcommand === 'list') {
    const discoveries = await plur.discoverRemoteScopes()

    if (shouldOutputJson(flags)) {
      outputJson({ discoveries })
      return
    }

    if (discoveries.length === 0) {
      outputText('No remote stores configured. Run `plur stores add` to connect one.')
      return
    }

    let anyOfferable = false

    for (const d of discoveries) {
      if (!d.ok) {
        outputText(`${d.url}: discovery failed — ${d.error}`)
        continue
      }
      if (d.unregistered.length === 0) continue

      anyOfferable = true
      outputText(`${d.url} (${d.username ?? 'unknown'}):`)
      for (const scope of d.unregistered) {
        const meta = d.metadata.find(m => m.scope === scope)
        const desc = meta?.description ? ` — ${meta.description}` : ''
        outputText(`  ${scope}${desc}`)
      }
    }

    if (!anyOfferable) {
      const dismissedCount = discoveries.reduce((n, d) => n + d.dismissed.length, 0)
      if (dismissedCount > 0) {
        outputText(`Nothing to register (${dismissedCount} scope(s) dismissed). Run \`plur scopes --reoffer\` to re-surface them.`)
      } else {
        outputText('Nothing to register — all authorized scopes are already registered.')
      }
    } else {
      outputText('\nRun `plur scopes register <scope>` to add one, or `plur scopes dismiss <scope>` to stop seeing it.')
    }
    return
  }

  exit(1, 'Usage: plur scopes [list|register <scope>|dismiss <scope>|--reoffer]')
}
