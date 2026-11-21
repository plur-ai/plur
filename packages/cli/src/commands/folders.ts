import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { createInterface } from 'readline'
import {
  FolderMapError, folderMapProblem, repairFolderMap, folderRepairCommand, folderQuoted,
  type FolderChange, type FolderEntry, type FolderMapIssue, type FolderMapProblem,
} from '@plur-ai/core'
import { plurRoot } from '../lib/folder-gate.js'

const USAGE =
  'Usage: plur folders list\n' +
  '       plur folders repair [--yes]\n' +
  '       plur folders set <folder> (--scope <s> | --on | --off | --ask | --remote-only --scope <s>) [--trusted | --no-trusted] [--nonce <n>] [--session <id>]\n' +
  '       plur folders set <folder> --not-now --nonce <n> [--session <id>]\n' +
  '       plur folders rm <folder> [--nonce <n>]\n' +
  'Without --nonce, set and rm work only from an interactive terminal.\n' +
  '--trusted covers the .plur.yaml files in every folder below it. A repository\'s own memory store is still added only after plur folders set <repo> --on, or plur trust <repo>.'

/**
 * Whether a `folders set`/`rm` or `trust` must carry a `--nonce`: unless both
 * stdin and stdout are TTYs, the caller is a script or agent, which must not
 * skip the nonce check by omitting `--nonce`. `plur untrust` is exempt (it
 * only removes trust). Does NOT stop a pty-wrapped process or direct edits of
 * folders.yaml; the nonce binds a write to one folder and answer, not a person.
 */
export function nonceRequired(stdinIsTTY: boolean | undefined, stdoutIsTTY: boolean | undefined): boolean {
  return !(stdinIsTTY === true && stdoutIsTTY === true)
}

/**
 * `plur folders` — the only way to write the folder map (`<PLUR home>/folders.yaml`):
 * on/off/ask, default write scope and trust per folder. A repo cannot write it.
 *   plur folders list
 *   plur folders set <folder> --scope <s> | --on | --off | --ask | --remote-only --scope <s>
 *                             [--trusted|--no-trusted] [--nonce <n>]
 *   plur folders rm <folder>
 * `--nonce` must be this folder's single-use session nonce; without it, writes need an interactive terminal.
 * A team `--scope` must name a configured store. `--remote-only`: memory lives only in team scope <s> (url store).
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const json = shouldOutputJson(flags)
  const sub = args[0]

  if (!sub || sub === 'list') {
    const plur = createPlur(flags, { readonly: true })
    // A broken map is not "no decisions": say where and what, and
    // offer the repair, instead of an empty list.
    const problem = folderMapProblem(plur.storageRoot)
    if (problem) return brokenMap(problem, flags, json)
    const folders = plur.listFolders()
    if (json) return outputJson({ folders, count: folders.length })
    if (folders.length === 0) return outputText('No folder decisions recorded.')
    for (const f of folders) outputText(describe(f))
    return
  }

  if (sub === 'repair') return repair(args.slice(1), flags, json)

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
      const removed = plur.removeFolder(folder, rmNonce !== undefined ? { nonce: rmNonce, ...nonceSession() } : undefined)
      if (json) return outputJson({ success: true, removed })
      return outputText(removed ? `Removed the entry for ${folder}.` : `${folder} has no entry of its own.`)
    } catch (err) {
      return fail(err, json)
    }
  }

  const change: FolderChange = {}
  let nonce: string | undefined
  let session: string | undefined
  let notNow = false
  let modes = 0
  let remoteOnly = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--on' || a === '--off' || a === '--ask') { change.mode = a.slice(2) as FolderChange['mode']; modes++ }
    else if (a === '--remote-only') remoteOnly = true
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
    else if (a === '--session') {
      const v = rest[++i]
      if (!v || v.startsWith('--')) exit(1, `--session needs a value.\n${USAGE}`)
      session = v
    }
    else if (a === '--not-now') { notNow = true; modes++ }
    else exit(1, `Unexpected argument ${a}.\n${USAGE}`)
  }
  if (remoteOnly) {
    // `--remote-only --scope <s>` is one decision: the scope is where the
    // folder's memory lives, so it is required, and no other mode goes with it.
    if (change.scope === undefined) exit(1, `--remote-only needs --scope <s>: the team scope this folder's memory goes to.\n${USAGE}`)
    if (change.mode !== undefined) exit(1, `--remote-only cannot be combined with --on, --off or --ask.\n${USAGE}`)
    if (notNow) exit(1, `--remote-only cannot be combined with --not-now.\n${USAGE}`)
    change.mode = 'remote-only'
    modes = 1
  }
  if (modes > 1) exit(1, `Pass only one of --scope, --on, --off, --ask, --not-now, --remote-only --scope <s>.\n${USAGE}`)
  if (modes === 0 && change.trusted === undefined) exit(1, `Nothing to set.\n${USAGE}`)

  // "Not now" (the MCP folder question): consume the nonce issued for
  // that answer and write nothing. It means nothing without its nonce.
  if (notNow) {
    if (change.trusted !== undefined) exit(1, `--not-now takes no --trusted / --no-trusted.\n${USAGE}`)
    if (nonce === undefined) exit(1, `--not-now is an answer to the folder question and needs its --nonce.\n${USAGE}`)
    const plur = createPlur(flags)
    try {
      plur.notNowFolder(folder, { nonce: nonce!, ...nonceSession(session, json) })
      if (json) return outputJson({ success: true, notNow: true })
      return outputInfo(`Not now: nothing recorded for ${folder}; the session that asked stops asking.`, flags)
    } catch (err) {
      return fail(err, json)
    }
  }
  refuseWithoutNonce(nonce, json)

  const plur = createPlur(flags)
  try {
    const entry = plur.setFolder(folder, change, nonce !== undefined ? { nonce, ...nonceSession(session, json) } : undefined)
    if (json) return outputJson({ success: true, entry })
    outputInfo(`Recorded: ${describe(entry)}`, flags)
  } catch (err) {
    fail(err, json)
  }
}

/**
 * The agent session this command runs in, when its host says so. The opencode
 * plugin sets PLUR_FOLDER_SESSION and binds its nonces to that session; editor
 * hooks leave nonces unbound. `--session <id>` lets the MCP server name the
 * session; if the environment names one too they must agree, so a host's
 * binding cannot be overridden from the command line.
 */
export function nonceSession(flag?: string, json = false): { session?: string } {
  const env = process.env.PLUR_FOLDER_SESSION
  if (flag !== undefined && env && env !== flag) {
    fail(new FolderMapError('nonce-session',
      'This command names a different session (--session) from the one this shell belongs to (PLUR_FOLDER_SESSION); nothing was changed. ' +
      'Run the command from the session that showed it, or decide by hand in a terminal: plur folders set <folder> --on | --off.'), json)
  }
  const s = flag ?? env
  return s ? { session: s } : {}
}

export function refuseWithoutNonce(nonce: string | undefined, json: boolean): void {
  if (nonce !== undefined || !nonceRequired(process.stdin.isTTY, process.stdout.isTTY)) return
  fail(new FolderMapError('nonce-required',
    'Not an interactive terminal: plur folders set/rm needs the --nonce the ask flow issued. ' +
    'Run it yourself in a terminal to record a decision by hand.'), json)
}

function describe(f: FolderEntry): string {
  const mode = f.plur ?? (f.scope !== undefined || f.trusted === true ? 'on' : '(no decision)')
  const parts = [mode]
  if (f.scope) parts.push(`scope ${f.scope}`)
  if (f.trusted) parts.push('trusted')
  return `${f.path}  ${parts.join(', ')}`
}

export function fail(err: unknown, json: boolean): never {
  const msg = err instanceof Error ? err.message : String(err)
  const code = err instanceof FolderMapError ? err.code : 'error'
  if (json) {
    outputJson({ success: false, error: msg, code })
    process.exit(1)
  }
  exit(1, msg)
}

/**
 * `plur folders repair` as the user types it, with `--path` when they gave
 * one — quoted by core's rules, the same as the agent form: POSIX single
 * quotes, so a pasted command never runs what a path holds.
 */
export function repairCommandFor(flags: GlobalFlags): string {
  if (!flags.path) return 'plur folders repair'
  const agent = folderRepairCommand(flags.path)
  if (agent === null) return 'plur folders repair (with --path naming your store)'
  return agent.startsWith('plur --path ') ? agent.replace(/ --yes$/, '') : `plur --path ${folderQuoted(flags.path)} folders repair`
}

/** What to do about a broken map, in one sentence (the CLI form of the offer). */
export function repairAdvice(problem: Pick<FolderMapProblem, 'fixable' | 'line'>, flags: GlobalFlags): string {
  const cmd = repairCommandFor(flags)
  return problem.fixable
    ? `Run \`${cmd}\` to see the fix and apply it (it saves a backup first).`
    : problem.line !== undefined
      ? `Fix line ${problem.line} by hand; \`${cmd}\` cannot fix this automatically, and re-checks the file.`
      : `Fix or remove the file by hand; \`${cmd}\` cannot fix this automatically.`
}

function brokenMap(problem: FolderMapProblem, flags: GlobalFlags, json: boolean): never {
  const error = `${problem.file} ${problem.problem}. Memory is paused until it is fixed. ${repairAdvice(problem, flags)}`
  if (json) {
    outputJson({
      success: false, code: 'malformed', error, file: problem.file,
      ...(problem.line !== undefined ? { line: problem.line } : {}),
      ...(problem.column !== undefined ? { column: problem.column } : {}),
      fixable: problem.fixable,
      ...(problem.fixable ? { repair: repairCommandFor(flags) } : {}),
    })
    process.exit(1)
  }
  exit(1, error)
}

const issueLines = (issues: FolderMapIssue[]) => issues.map(i => `  ${i.message}`)

/** Ask a yes/no question on the terminal; anything but y/yes is no. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer: string = await new Promise(res => rl.question(question, res))
    return /^\s*y(es)?\s*$/i.test(answer)
  } finally {
    rl.close()
  }
}

/**
 * `plur folders repair [--yes]`: fix unambiguous breakage in folders.yaml
 * (indentation, tabs, key/mode typos, empty file), keeping comments. Shows a
 * diff and asks; without `--yes` a non-interactive run is a dry run exiting
 * nonzero. Backs up to `folders.yaml.plur-backup-<UTC>`, writes atomically and
 * re-checks. No nonce: it only respells decisions the file already holds.
 */
async function repair(rest: string[], flags: GlobalFlags, json: boolean): Promise<void> {
  let yes = false
  for (const a of rest) {
    if (a === '--yes' || a === '-y') yes = true
    else exit(1, `Unexpected argument ${a}.\n${USAGE}`)
  }
  const root = plurRoot(flags)
  const shown = repairFolderMap(root, { apply: false })
  const out = (body: Record<string, unknown>, text: string[], code: number): void => {
    if (json) outputJson({ file: shown.file, ...body })
    else for (const l of text) outputText(l)
    if (code !== 0) process.exit(code)
  }

  switch (shown.status) {
    case 'absent':
      return out({ status: 'absent' }, [`There is no folder map at ${shown.file}; nothing to repair.`], 0)
    case 'ok':
      return out({ status: 'ok' }, [`${shown.file} is fine; nothing to repair.`], 0)
    case 'unreadable':
      return out({ status: 'unreadable', problem: shown.problem },
        [`${shown.file} ${shown.problem}.`, 'plur folders repair cannot fix this: fix or remove the file by hand. Nothing was changed.'], 1)
    case 'unfixable':
      return out({ status: 'unfixable', problems: shown.issues }, [
        `${shown.file} has ${shown.issues!.length === 1 ? 'a problem' : 'problems'} that plur folders repair cannot fix automatically:`,
        ...issueLines(shown.issues!),
        'Fix it by hand, then run plur folders repair again to check it. Nothing was changed.',
      ], 1)
    default:
      break
  }

  // Fixable: show what and how.
  const preview = [
    `${shown.file} has ${shown.fixes!.length === 1 ? 'a problem' : 'problems'} plur folders repair can fix:`,
    ...issueLines(shown.fixes!),
    '',
    `In short: ${shown.summary}`,
    '',
    shown.diff!.trimEnd(),
    '',
  ]
  const interactive = !json && process.stdin.isTTY === true && process.stdout.isTTY === true
  if (!yes) {
    if (!interactive) {
      return out({ status: 'dry-run', problems: shown.fixes, summary: shown.summary, diff: shown.diff }, [
        ...preview,
        `Dry run (not an interactive terminal): nothing was changed. To apply it: ${repairCommandFor(flags)} --yes`,
      ], 1)
    }
    for (const l of preview) outputText(l)
    if (!(await confirm('Apply this change? A backup of the file is saved first. [y/N] '))) {
      outputText('Nothing was changed.')
      process.exit(1)
    }
  } else if (!json) {
    for (const l of preview) outputText(l)
  }

  const done = repairFolderMap(root, { apply: true, expect: shown.before })
  if (done.status === 'changed') {
    return out({ status: 'changed' }, [`${shown.file} changed while this ran; nothing was written. Run plur folders repair again.`], 1)
  }
  if (done.status !== 'repaired') {
    return out({ status: done.status, problems: done.issues ?? [] }, [`${shown.file} could not be repaired (${done.status}); nothing was changed.`], 1)
  }
  const after = done.problemAfter ?? null
  return out({
    status: 'repaired', backup: done.backup, problems: shown.fixes, summary: shown.summary, diff: shown.diff, ok_after: after === null,
    ...(after ? { problem_after: after.problem } : {}),
  }, [
    `Repaired ${shown.file}.`,
    `The original is saved as ${done.backup}.`,
    after ? `It still has a problem: ${after.problem}. ${repairAdvice(after, flags)}` : 'Checked again: the folder map is valid now.',
  ], after ? 1 : 0)
}
