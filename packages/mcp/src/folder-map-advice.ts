import { folderRepairCommand, type FolderMapProblem } from '@plur-ai/core'

/**
 * What the agent may do about a broken map (#1526), in agent form: the exact
 * repair command, to run only after the user agrees. The CLI form is the same
 * command without --yes, which shows the change and asks.
 */
export function folderMapAdvice(problem: Pick<FolderMapProblem, 'fixable' | 'line'>, root: string): { text: string; command?: string } {
  const command = problem.fixable ? folderRepairCommand(root) : null
  if (command) {
    return {
      command,
      text:
        `PLUR can repair this. Tell the user what is wrong and ask whether to repair the file (a backup is saved first; ` +
        `they can see the change before it is made by running plur folders repair in a terminal). Only after the user agrees, run: ${command}`,
    }
  }
  if (problem.fixable) return { text: 'The user can repair it by running plur folders repair in a terminal (it shows the change and asks first).' }
  return {
    text: problem.line !== undefined
      ? `plur folders repair cannot fix this automatically: the user has to fix line ${problem.line} of that file by hand (plur folders repair then checks it).`
      : 'plur folders repair cannot fix this automatically: the user has to fix or remove that file by hand.',
  }
}
