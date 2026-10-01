/**
 * The folder question stays actionable until the folder is decided (audit F2
 * of #1517). opencode rebuilds the system prompt for every request and keeps
 * none of it in history, so a question shown once is gone on the turn the
 * user answers it. Every later turn of an undecided session therefore carries
 * a reminder with the SAME commands and nonces (none is issued again), told
 * not to ask again. It is built only from the question's own lines, so it
 * holds nothing the question did not.
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
    'If the user answers now, run the command for their answer:',
    ...commands,
    ...(footer ? [footer] : []),
  ].join('\n')
}
