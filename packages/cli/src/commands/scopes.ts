import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

/**
 * `plur scopes` (#647) — the user-facing surface for authorized-but-unregistered
 * shared scopes. The session-start "N scopes available" hint is agent-facing
 * only; this command is where a human actually decides per scope:
 *
 *   plur scopes                 list authorized-but-unregistered shared scopes
 *   plur scopes register <s>    register one scope
 *   plur scopes dismiss  <s>    remember "don't offer this one" (persisted)
 *   plur scopes --reoffer       clear all dismissals — offer them again
 *
 * Dismissed scopes are excluded from the list (and the session-start hint) until
 * `--reoffer`. Personal-family scopes are never offered (see registerScope/#382).
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const json = shouldOutputJson(flags)

  // --reoffer: clear dismissals (works as a flag on the bare command).
  if (args.includes('--reoffer')) {
    const cleared = plur.getDismissedScopes()
    plur.reofferScopes()
    if (json) return outputJson({ success: true, action: 'reoffer', cleared })
    return outputText(cleared.length
      ? `Re-offering ${cleared.length} previously dismissed scope(s): ${cleared.join(', ')}`
      : 'No dismissed scopes to re-offer.')
  }

  const subcommand = args[0]

  if (subcommand === 'register') {
    const scope = args[1]
    if (!scope) exit(1, 'Usage: plur scopes register <scope>')
    try {
      const { url, status } = await plur.registerScope(scope)
      if (json) return outputJson({ success: true, action: 'register', scope, url, status })
      const verb = status === 'added' ? 'Registered' : status === 'token_rotated' ? 'Rotated token for' : 'Already registered'
      return outputText(`${verb} scope "${scope}" (${url}).`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (json) return outputJson({ success: false, action: 'register', scope, error: msg })
      return exit(1, msg)
    }
  }

  if (subcommand === 'dismiss') {
    const scope = args[1]
    if (!scope) exit(1, 'Usage: plur scopes dismiss <scope>')
    plur.dismissScope(scope)
    if (json) return outputJson({ success: true, action: 'dismiss', scope })
    return outputText(`Dismissed "${scope}" — it won't be offered again. Run \`plur scopes --reoffer\` to undo.`)
  }

  // Default (or `list`): show the offerable set.
  if (subcommand && subcommand !== 'list') {
    exit(1, `Unknown subcommand "${subcommand}". Usage: plur scopes [list] | register <scope> | dismiss <scope> | --reoffer`)
  }

  const { scopes: offered, failures } = await plur.offerableScopes()
  if (json) {
    return outputJson({ success: failures.length === 0, action: 'list', scopes: offered, failures })
  }

  // Don't report an empty offer when we simply couldn't reach the remote (#656):
  // if nothing is offerable AND a remote failed, that's an error, not "nothing to do".
  if (offered.length === 0 && failures.length > 0) {
    const urls = failures.map(f => f.url).join(', ')
    return exit(1, `Could not reach ${failures.length} remote store(s): ${urls}. ` +
      `Check connectivity/VPN and that the token is valid (\`plur doctor\`).`)
  }
  if (offered.length === 0) {
    return outputText('No authorized-but-unregistered scopes to offer. (Nothing to register.)')
  }
  outputText(`${offered.length} scope(s) authorized but not yet registered:\n`)
  for (const o of offered) {
    outputText(`  ${o.scope}${o.description ? ` — ${o.description}` : ''}`)
  }
  // Some remotes returned scopes but others failed — say so, don't hide it.
  if (failures.length > 0) {
    outputText(`\n(warning: could not reach ${failures.map(f => f.url).join(', ')} — that store's scopes may be missing above.)`)
  }
  outputText(`\nRegister one:  plur scopes register <scope>`)
  outputText(`Dismiss one:   plur scopes dismiss <scope>`)
}
