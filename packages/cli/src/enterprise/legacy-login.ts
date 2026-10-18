/**
 * The one-time move of `~/.plur/config.json` into config.yaml (#1638, owner
 * decision O15: one config file for users).
 *
 * `plur login` before #1638 wrote `{ enterprise: { url, token, … } }` to
 * `~/.plur/config.json`, which nothing on the recall path ever read. Now
 * `plur login` writes the server entry to config.yaml instead. A remaining
 * config.json is read once:
 *   - config.yaml already holds a sign-in to that server: nothing is moved —
 *     the sign-in in config.yaml is newer, and is never replaced by the old
 *     key (nor is the old key sent to the server);
 *   - the server still accepts its key (/me answers): the key is registered
 *     as that server's entry in config.yaml (`Plur.registerEnterpriseServer`,
 *     the config write path), with the personal scope from /me;
 *   - the server refuses the key, the file holds no sign-in, or registration
 *     is refused because another entry holds the personal scope: nothing is
 *     moved, and the notice says why and what to run;
 * and in each of those cases the file is moved to
 * `~/.plur/backups/<stamp>/config.json` (owner-only, verified: core's
 * `protectOwnerOnly` through sign-in-shared.ts), so it is not read again.
 * Only when the server cannot be reached, config.yaml cannot be written, or
 * the owner-only copy cannot be made, does the file stay for the next run.
 * One notice per run; the key is never printed.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { redactToken, normalizeEndpointUrl, PersonalScopeTakenError, type Plur } from '@plur-ai/core'
import { fetchMe, personalScopeOf, normaliseHost, takeoverMessage, backupSecretFile, type BackupHost } from './sign-in-shared.js'

export type LegacyLoginOutcome = 'none' | 'migrated' | 'set-aside' | 'kept'

export async function migrateLegacyLogin(opts: {
  home: string
  plur: () => Plur
  print: (line: string) => void
  fetch?: typeof fetch
  /** Tests: the host the owner-only protection of the copy runs on. */
  backupHost?: BackupHost
}): Promise<LegacyLoginOutcome> {
  const file = join(opts.home, '.plur', 'config.json')
  if (!existsSync(file)) return 'none'
  const shown = '~/.plur/config.json'

  let ent: { url?: unknown; token?: unknown } | undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { enterprise?: { url?: unknown; token?: unknown } } | null
    ent = parsed && typeof parsed === 'object' ? parsed.enterprise : undefined
  } catch { ent = undefined }

  let origin: string | undefined
  try { origin = typeof ent?.url === 'string' ? normaliseHost(ent.url) : undefined } catch { origin = undefined }
  const token = typeof ent?.token === 'string' && ent.token ? ent.token : undefined
  const say = (line: string): void => opts.print(token ? redactToken(line, token) : line)

  /** Move the file to an owner-only copy; on failure it stays, and false. */
  const setAside = (lead: string[]): boolean => {
    let dest: string
    try {
      dest = backupSecretFile(join(opts.home, '.plur'), file, opts.backupHost)
      unlinkSync(file)
    } catch (err) {
      for (const l of lead) say(l)
      say(`${shown} could not be set aside (${err instanceof Error ? err.message : String(err)}). It stays, and is read again at the next \`plur login\`.`)
      return false
    }
    for (const l of lead) say(l)
    say(`${shown} is no longer read; it was moved to ${dest}.`)
    return true
  }

  if (!origin || !token) {
    return setAside([`${shown} is no longer read by PLUR and held no sign-in to move.`]) ? 'set-aside' : 'kept'
  }

  const plur = opts.plur()
  // config.yaml already signs in to this server: it is newer than config.json
  // (written by an older `plur login`), so it is kept as it is.
  let held: { token?: string }[] = []
  try {
    const key = normalizeEndpointUrl(origin)
    held = plur.remoteEndpointTokenGroups().filter(g => normalizeEndpointUrl(g.url) === key)
  } catch { held = [] }
  if (held.length) {
    const same = held.some(g => g.token === token)
    return setAside([same
      ? `The sign-in to ${origin} in ${shown} is already in config.yaml.`
      : `config.yaml already holds a sign-in to ${origin}, so the older one in ${shown} was not moved into it. If that sign-in stops working, run \`plur login ${origin}\`.`,
    ]) ? 'set-aside' : 'kept'
  }

  const me = await fetchMe(origin, token, { fetch: opts.fetch, timeoutMs: 3_000 })
  if (me.status === 'unknown') {
    say(`${shown} holds a sign-in to ${origin} that could not be checked now (${me.reason}). It will be moved into config.yaml at the next \`plur login\`.`)
    return 'kept'
  }
  if (me.status === 'rejected') {
    return setAside([
      `The sign-in to ${origin} in ${shown} is no longer accepted by the server, so it was not moved into config.yaml.`,
      `Run \`plur login ${origin}\` to sign in again.`,
    ]) ? 'set-aside' : 'kept'
  }

  try {
    await plur.registerEnterpriseServer(origin, { token, personalScope: personalScopeOf(me) })
  } catch (err) {
    if (err instanceof PersonalScopeTakenError) {
      const lead = `The sign-in to ${origin} in ${shown} was not moved into config.yaml:`
      return setAside(takeoverMessage(err, origin, 'config.yaml', { lead, notSaved: ' in config.yaml' })) ? 'set-aside' : 'kept'
    }
    say(`The sign-in to ${origin} in ${shown} could not be moved into config.yaml (${err instanceof Error ? err.message : String(err)}). It stays for the next \`plur login\`.`)
    return 'kept'
  }
  setAside([`The sign-in to ${origin} in ${shown} was moved into config.yaml.`])
  return 'migrated'
}
