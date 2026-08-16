import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LogEvent } from '../../src/session-log.js'

/**
 * An agent-shaped value for driving host APIs in tests.
 *
 * The real `Agent` has eleven members this plugin never touches — `options`,
 * `inbox`, `status`, `ctx`, cancellation, and so on. Constructing all of them
 * would be fabricating a host, which is how the contract mismatches got here
 * in the first place. What matters is that the fields the plugin DOES read
 * (`id`, `session.id`, `session.events`, `session.header.cwd`) carry real
 * shapes; the cast is confined to this one place so every call site is honest
 * about which parts are real.
 *
 * @param id - the agent and session id.
 * @param cwd - the workspace directory the scope is derived from.
 * @param events - the session log.
 * @returns a value usable wherever the host wants an `Agent`.
 */
export function fakeAgent(
  id = 'a1',
  cwd = '/tmp/hc',
  events: readonly LogEvent[] = [],
): Agent {
  return { id, session: { id: `s-${id}`, events, header: { cwd } } } as unknown as Agent
}

/**
 * A session log carrying one human turn.
 *
 * The recall query is built from the turn's human text, so a session without
 * one recalls nothing — and a test that forgets it sees an empty block for a
 * reason unrelated to what it is checking.
 *
 * @param text - what the user asked.
 * @returns the events, oldest first.
 */
export function askedEvents(text: string): LogEvent[] {
  return [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      time: 2,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    },
  ]
}
