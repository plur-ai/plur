/**
 * The one-time move of `~/.plur/config.json` into config.yaml (#1638, owner
 * decision O15: one config file for users).
 *
 * `plur login` before #1638 wrote `{ enterprise: { url, token, … } }` to
 * `~/.plur/config.json`, which nothing on the recall path ever read. Now
 * `plur login` writes the server entry to config.yaml instead. A remaining
 * config.json is read once:
 *   - the server still accepts its key (/me answers): the key is registered
 *     as that server's entry in config.yaml (`Plur.registerEnterpriseServer`,
 *     the config write path), with the personal scope from /me;
 *   - the server refuses the key, the file holds no sign-in, or registration
 *     is refused because another entry holds the personal scope: nothing is
 *     moved, and the notice says why and what to run;
 * and in each of those cases the file is moved to
 * `~/.plur/backups/<stamp>/config.json` (owner-only), so it is not read
 * again. Only when the server cannot be reached, or config.yaml cannot be
 * written, does the file stay for the next run. One notice per run; the key
 * is never printed.
 */
import { existsSync, readFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync, chmodSync } from 'fs'
import { join } from 'path'
import { redactToken, PersonalScopeTakenError, type Plur } from '@plur-ai/core'
import { fetchMe, personalScopeOf, normaliseHost, takeoverMessage } from '../commands/login.js'

export type LegacyLoginOutcome = 'none' | 'migrated' | 'set-aside' | 'kept'

/** Move the file into `<home>/.plur/backups/<stamp>/config.json`, owner-only. */
function setAside(file: string, home: string): string {
  const dir = join(home, '.plur', 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dest = join(dir, 'config.json')
  try {
    renameSync(file, dest)
  } catch {
    copyFileSync(file, dest)
    unlinkSync(file)
  }
  try { chmodSync(dest, 0o600) } catch { /* Windows: the folder's ACL applies */ }
  return dest
}

export async function migrateLegacyLogin(opts: {
  home: string
  plur: () => Plur
  print: (line: string) => void
  fetch?: typeof fetch
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
  if (!origin || !token) {
    const dest = setAside(file, opts.home)
    opts.print(`${shown} is no longer read by PLUR and held no sign-in to move. It was moved to ${dest}.`)
    return 'set-aside'
  }
  const say = (line: string): void => opts.print(redactToken(line, token))

  const me = await fetchMe(origin, token, { fetch: opts.fetch, timeoutMs: 3_000 })
  if (me.status === 'unknown') {
    say(`${shown} holds a sign-in to ${origin} that could not be checked now (${me.reason}). It will be moved into config.yaml at the next \`plur login\`.`)
    return 'kept'
  }
  if (me.status === 'rejected') {
    const dest = setAside(file, opts.home)
    say(`The sign-in to ${origin} in ${shown} is no longer accepted by the server, so it was not moved into config.yaml.`)
    say(`Run \`plur login ${origin}\` to sign in again. ${shown} is no longer read; it was moved to ${dest}.`)
    return 'set-aside'
  }

  const plur = opts.plur()
  try {
    await plur.registerEnterpriseServer(origin, { token, personalScope: personalScopeOf(me) })
  } catch (err) {
    if (err instanceof PersonalScopeTakenError) {
      const dest = setAside(file, opts.home)
      const lead = `The sign-in to ${origin} in ${shown} was not moved into config.yaml:`
      for (const l of takeoverMessage(err, origin, 'config.yaml', { lead, notSaved: ' in config.yaml' })) say(l)
      say(`${shown} is no longer read; it was moved to ${dest}.`)
      return 'set-aside'
    }
    say(`The sign-in to ${origin} in ${shown} could not be moved into config.yaml (${err instanceof Error ? err.message : String(err)}). It stays for the next \`plur login\`.`)
    return 'kept'
  }
  const dest = setAside(file, opts.home)
  say(`The sign-in to ${origin} in ${shown} was moved into config.yaml. ${shown} is no longer read; it was moved to ${dest}.`)
  return 'migrated'
}
