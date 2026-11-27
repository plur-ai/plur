import { isatty } from 'tty'
import { createInterface } from 'readline'
import type { ChangeRecord, Plur } from '@plur-ai/core'
import { exit } from '../output.js'

/**
 * Audit S1: under `pinning.agents: request` or `deny`, the commands that
 * grant pins or apply a journalled change in bulk — `plur pin`, `plur pin
 * review approve`, `plur pin apply`, `consolidate --apply`, `enrich --apply`,
 * `rescope --apply` — need a confirmation typed at an interactive terminal.
 * PLUR_ACTOR=owner makes the CLI the owner, but an agent with a shell can set
 * that variable as easily as a person; it cannot type at the person's
 * terminal (an agent's shell tool runs without one). Under `allow` (the
 * default) nothing is asked. Exits 1 when refused; returns when confirmed.
 * H11/H12: `plur import` of pinned records and an undo that puts a pin back
 * ask the same question. 0.24 audit: so do `plur pin priority` when it raises
 * a pin, and registering a store (`plur stores add`, `plur remote`), whose
 * pinned engrams load into every session.
 */
export async function requirePinPolicyConfirmation(
  plur: Pick<Plur, 'pinPolicyFor'>,
  action: string,
  io: { stdinIsTTY?: boolean } = {},
): Promise<void> {
  const answer = await askPinPolicyConfirmation(plur, action, io)
  if (answer.confirmed) return
  if (answer.reason === 'no-terminal') {
    exit(1, `${action} is refused: pinning.agents is "${answer.policy}", so it needs a confirmation typed at an interactive terminal, `
      + 'and stdin is not a terminal. An agent cannot confirm this; run the command yourself in a terminal.')
  }
  exit(1, `${action}: not confirmed, nothing changed.`)
}

export type PinPolicyAnswer =
  | { confirmed: true; policy: string }
  | { confirmed: false; policy: string; reason: 'no-terminal' | 'declined' }

/**
 * The S1 question without the exit: confirmed under `allow` without asking,
 * otherwise only by "yes" typed at an interactive terminal. For a command
 * that carries on without the pins when they are not confirmed (H11 import).
 */
export async function askPinPolicyConfirmation(
  plur: Pick<Plur, 'pinPolicyFor'>,
  action: string,
  io: { stdinIsTTY?: boolean } = {},
): Promise<PinPolicyAnswer> {
  let policy: string
  try { policy = plur.pinPolicyFor('agent') } catch { policy = 'request' }
  if (policy === 'allow') return { confirmed: true, policy }
  const tty = io.stdinIsTTY ?? isatty(0)
  if (!tty) return { confirmed: false, policy, reason: 'no-terminal' }
  const answer = await new Promise<string>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    rl.question(`pinning.agents is "${policy}". ${action}? Type yes to continue: `, a => { resolve(a); rl.close() })
    rl.once('close', () => resolve(''))
  })
  return answer.trim().toLowerCase() === 'yes' ? { confirmed: true, policy } : { confirmed: false, policy, reason: 'declined' }
}

/** A row in force as a pin: present, active and pinned. */
function isLivePin(e: { pinned?: unknown; status?: unknown } | null | undefined): boolean {
  return !!e && e.pinned === true && e.status === 'active'
}

/**
 * H12: how many pins undoing `change` would put back into force — rows live
 * and pinned before the change and not after it (unpinned, removed, or
 * retired by a consolidation, which keeps the original's pin flag). Core's
 * undo restores the before-rows unpoliced, so the undo commands ask the S1
 * question when this is not zero.
 */
export function undoRestoresPins(change: Pick<ChangeRecord, 'rows'>): number {
  return change.rows.filter(r => isLivePin(r.before) && !isLivePin(r.after)).length
}

/** H12: the S1 confirmation before an undo that puts pins back; returns at once when it puts none back. */
export async function confirmUndoPins(plur: Pick<Plur, 'pinPolicyFor'>, change: Pick<ChangeRecord, 'id' | 'rows'>): Promise<void> {
  const n = undoRestoresPins(change)
  if (n === 0) return
  await requirePinPolicyConfirmation(plur, `Undo ${change.id}, which pins ${n} engram${n === 1 ? '' : 's'} again`)
}
