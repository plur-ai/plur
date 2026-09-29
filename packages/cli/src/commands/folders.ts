import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { FolderMapError, type FolderChange, type FolderEntry } from '@plur-ai/core'

const USAGE =
  'Usage: plur folders list\n' +
  '       plur folders set <folder> (--scope <s> | --on | --off | --ask) [--trusted | --no-trusted] [--nonce <n>]\n' +
  '       plur folders rm <folder> [--nonce <n>]\n' +
  'Without --nonce, set and rm work only from an interactive terminal.'

/**
 * Whether a `set`/`rm` must carry the ask flow's `--nonce`.
 *
 * Only a person at a terminal may write the map without one. When stdin or
 * stdout is not a TTY, the caller is a script or an agent (the ask flow runs
 * the command from a tool call), and without this an agent could skip the
 * nonce check simply by omitting `--nonce`, and write any folder, `--trusted`
 * included. `plur trust` is the explicit human alias and keeps working in
 * scripts; it does not go through here.
 */
export function nonceRequired(stdinIsTTY: boolean | undefined, stdoutIsTTY: boolean | undefined): boolean {
  return !(stdinIsTTY === true && stdoutIsTTY === true)
}

/**
 * `plur folders` (#1347) — the only way to write the folder map
 * (`<PLUR home>/folders.yaml`): your on / off / ask decision, default write
 * scope and trust grant per folder. A repo cannot write it; `.plur.yaml`
 * stays the repo's request.
 *
 *   plur folders list
 *   plur folders set <folder> --scope <s> | --on | --off | --ask  [--trusted|--no-trusted] [--nonce <n>]
 *   plur folders rm <folder>
 *
 * `--nonce` is what the ask flow passes: it must be the nonce issued for this
 * folder in this session, and it works once. Without `--nonce`, `set` and `rm`
 * are accepted only from an interactive terminal (see nonceRequired). A team
 * `--scope` must name a store already configured in config.yaml.
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const json = shouldOutputJson(flags)
  const sub = args[0]

  if (!sub || sub === 'list') {
    const plur = createPlur(flags, { readonly: true })
    const folders = plur.listFolders()
    if (json) return outputJson({ folders, count: folders.length })
    if (folders.length === 0) return outputText('No folder decisions recorded. Unmapped folders ask once per session.')
    for (const f of folders) outputText(describe(f))
    return
  }

  if (sub !== 'set' && sub !== 'rm') exit(1, `Unknown subcommand "${sub}".\n${USAGE}`)

  const folder = args[1]
  if (!folder || folder.startsWith('--')) exit(1, `plur folders ${sub} needs a folder.\n${USAGE}`)
  const rest = args.slice(2)

  if (sub === 'rm') {
    let rmNonce: string | undefined
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--nonce' && rest[i + 1] && !rest[i + 1].startsWith('--')) { rmNonce = rest[++i]; continue }
      exit(1, `Unexpected argument ${rest[i]}.\n${USAGE}`)
    }
    refuseWithoutNonce(rmNonce, json)
    const plur = createPlur(flags)
    try {
      const removed = plur.removeFolder(folder, rmNonce !== undefined ? { nonce: rmNonce } : undefined)
      if (json) return outputJson({ success: true, removed })
      return outputText(removed ? `Removed the entry for ${folder}.` : `${folder} has no entry of its own.`)
    } catch (err) {
      return fail(err, json)
    }
  }

  const change: FolderChange = {}
  let nonce: string | undefined
  let modes = 0
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--on' || a === '--off' || a === '--ask') { change.mode = a.slice(2) as FolderChange['mode']; modes++ }
    else if (a === '--scope') {
      const v = rest[++i]
      if (!v || v.startsWith('--')) exit(1, `--scope needs a scope.\n${USAGE}`)
      change.scope = v; modes++
    }
    else if (a === '--trusted') change.trusted = true
    else if (a === '--no-trusted') change.trusted = false
    else if (a === '--nonce') {
      const v = rest[++i]
      if (!v || v.startsWith('--')) exit(1, `--nonce needs a value.\n${USAGE}`)
      nonce = v
    }
    else exit(1, `Unexpected argument ${a}.\n${USAGE}`)
  }
  if (modes > 1) exit(1, `Pass only one of --scope, --on, --off, --ask.\n${USAGE}`)
  if (modes === 0 && change.trusted === undefined) exit(1, `Nothing to set.\n${USAGE}`)
  refuseWithoutNonce(nonce, json)

  const plur = createPlur(flags)
  try {
    const entry = plur.setFolder(folder, change, nonce !== undefined ? { nonce } : undefined)
    if (json) return outputJson({ success: true, entry })
    outputInfo(`Recorded: ${describe(entry)}`, flags)
  } catch (err) {
    fail(err, json)
  }
}

function refuseWithoutNonce(nonce: string | undefined, json: boolean): void {
  if (nonce !== undefined || !nonceRequired(process.stdin.isTTY, process.stdout.isTTY)) return
  fail(new FolderMapError('nonce-required',
    'Not an interactive terminal: plur folders set/rm needs the --nonce the ask flow issued. ' +
    'Run it yourself in a terminal to record a decision by hand (or use plur trust <dir> for a trust grant).'), json)
}

function describe(f: FolderEntry): string {
  const mode = f.plur ?? (f.scope !== undefined || f.trusted === true ? 'on' : '(no decision)')
  const parts = [mode]
  if (f.scope) parts.push(`scope ${f.scope}`)
  if (f.trusted) parts.push('trusted')
  return `${f.path}  ${parts.join(', ')}`
}

function fail(err: unknown, json: boolean): never {
  const msg = err instanceof Error ? err.message : String(err)
  const code = err instanceof FolderMapError ? err.code : 'error'
  if (json) {
    outputJson({ success: false, error: msg, code })
    process.exit(1)
  }
  exit(1, msg)
}
