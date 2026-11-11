import { isatty } from 'tty'
import { createInterface } from 'readline'
import type { Plur } from '@plur-ai/core'
import { exit } from '../output.js'

/**
 * Audit S1: under `pinning.agents: request` or `deny`, the commands that
 * grant pins or apply a journalled change in bulk — `plur pin`, `plur pins
 * review approve`, `plur pins apply`, `consolidate --apply`, `enrich --apply`,
 * `rescope --apply` — need a confirmation typed at an interactive terminal.
 * PLUR_ACTOR=owner makes the CLI the owner, but an agent with a shell can set
 * that variable as easily as a person; it cannot type at the person's
 * terminal (an agent's shell tool runs without one). Under `allow` (the
 * default) nothing is asked. Exits 1 when refused; returns when confirmed.
 */
export async function requirePinPolicyConfirmation(
  plur: Pick<Plur, 'pinPolicyFor'>,
  action: string,
  io: { stdinIsTTY?: boolean } = {},
): Promise<void> {
  let policy: string
  try { policy = plur.pinPolicyFor('agent') } catch { policy = 'request' }
  if (policy === 'allow') return
  const tty = io.stdinIsTTY ?? isatty(0)
  if (!tty) {
    exit(1, `${action} is refused: pinning.agents is "${policy}", so it needs a confirmation typed at an interactive terminal, `
      + 'and stdin is not a terminal. An agent cannot confirm this; run the command yourself in a terminal.')
  }
  const answer = await new Promise<string>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    rl.question(`pinning.agents is "${policy}". ${action}? Type yes to continue: `, a => { resolve(a); rl.close() })
    rl.once('close', () => resolve(''))
  })
  if (answer.trim().toLowerCase() !== 'yes') exit(1, `${action}: not confirmed, nothing changed.`)
}
