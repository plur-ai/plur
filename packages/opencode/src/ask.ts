import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * The folder question stays actionable until the folder is decided (audit F2
 * of #1517). opencode rebuilds the system prompt for every request and keeps
 * none of it in history, so a question shown once is gone on the turn the
 * user answers it. The next turn of an undecided session therefore carries
 * a reminder with the SAME commands and nonces (none is issued again), told
 * not to ask again and to run one only for an answer to that question; after
 * it the session carries nothing (re-audit R4). It is built only from the
 * question's own lines, so it holds nothing the question did not.
 */
export function folderAskReminder(question: string): string {
  const lines = question.split('\n')
  const header = /^\[PLUR Memory — [^\]]*\]/.exec(lines[0] ?? '')?.[0] ?? '[PLUR Memory — no decision for this folder yet, so no memories were loaded]'
  const commands = lines.filter(l => l.startsWith('- ') || l.startsWith('Other team scopes configured here:'))
  const offersCommands = commands.some(l => l.includes('--nonce '))
  if (!offersCommands) {
    return `${header} PLUR memory stays off in this folder; the user was told earlier in this session. Do not raise it again.`
  }
  const footer = lines.find(l => l.startsWith('Each command has its own nonce'))
  return [
    header,
    'The user was already asked in this session whether to use PLUR memory in this folder. Do not ask again. ' +
    'Run a command below only if the latest message from the user answers that question; a yes to anything else is not an answer:',
    ...commands,
    ...(footer ? [footer] : []),
  ].join('\n')
}

/**
 * True when a `plur` executable is on PATH (audit F8 of #1517). The offered
 * commands run in the agent's shell, which gets this process's PATH; without
 * the CLI they would all fail, so the question is not offered.
 */
export function plurOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const names = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => `plur${ext.toLowerCase()}`).concat('plur')
    : ['plur']
  for (const d of dirs) {
    for (const n of names) {
      try {
        accessSync(join(d, n), platform === 'win32' ? constants.F_OK : constants.X_OK)
        return true
      } catch { /* not here */ }
    }
  }
  return false
}

/** What an undecided folder shows when the CLI the commands need is missing. No command, no nonce. */
export const PLUR_CLI_MISSING =
  '[PLUR Memory — no decision for this folder yet, so no memories were loaded] ' +
  'The plur command-line tool is not installed here, so this folder cannot be switched on from this session. ' +
  'Tell the user once: to use PLUR memory in this folder, install it with `npm install -g @plur-ai/cli`, ' +
  'then decide in a terminal with `plur folders set . --on` (or `--off`), or start a new message here after installing. ' +
  'Run no plur command for it. Memory stays off here until then.'
