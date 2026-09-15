import { describe, it, expect } from 'vitest'
import { TurnBuffer } from '../src/turn.js'

describe('TurnBuffer', () => {
  it('accumulates assistant text per session, one entry per part', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_a', 'msg_asst', 'hello')
    b.append('ses_1', 'prt_b', 'msg_asst', 'world')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello', 'world'])
  })

  it('returns undefined on a second take — session.idle fires twice', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_a', 'msg_asst', 'hello')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello'])
    expect(b.takeIfFresh('ses_1')).toBeUndefined()
  })

  it('becomes fresh again when the next turn appends', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_a', 'msg_1', 'turn one')
    b.takeIfFresh('ses_1')
    b.append('ses_1', 'prt_b', 'msg_2', 'turn two')
    expect(b.takeIfFresh('ses_1')).toEqual(['turn two'])
  })

  it('ignores empty text', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_a', 'msg_1', '')
    expect(b.takeIfFresh('ses_1')).toBeUndefined()
  })

  // Confirmed against the real opencode 1.18.30 binary (repo probe,
  // scripts/probes/opencode-plugin-probe.mjs): message.part.updated delivers
  // CUMULATIVE snapshots of one part, not deltas — the same part id arrives
  // repeatedly with growing text ("" -> "1" -> "1\n2\n3..."). A blind append
  // would store every intermediate snapshot, risking the self-report marker
  // appearing both truncated and complete in the same joined buffer.
  it('a repeated update to the same part id contributes its final text exactly once', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_x', 'msg_asst', '')
    b.append('ses_1', 'prt_x', 'msg_asst', '1')
    b.append('ses_1', 'prt_x', 'msg_asst', '1\n2\n3')
    expect(b.takeIfFresh('ses_1')).toEqual(['1\n2\n3'])
  })

  it('keeps distinct part ids separate even when their updates interleave', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_a', 'msg_asst', 'first')
    b.append('ses_1', 'prt_b', 'msg_asst', 'second')
    b.append('ses_1', 'prt_a', 'msg_asst', 'first (updated)')
    expect(b.takeIfFresh('ses_1')).toEqual(['first (updated)', 'second'])
  })

  // Confirmed against the real binary: message.part.updated also fires for
  // the USER's own submitted message part (not just the assistant's
  // streamed response). Left unfiltered, the user's prompt text would be
  // captured as "assistant text" and fed to the self-report parser every
  // turn — semantically wrong, and a user message that happened to contain
  // a literal 🧠 I learned: block would inject learnings through a path
  // meant to read only the model's own self-report.
  it('excludes parts belonging to the recorded user message for that session', () => {
    const b = new TurnBuffer()
    b.markUserMessage('ses_1', 'msg_user')
    b.append('ses_1', 'prt_user', 'msg_user', 'Count slowly from 1 to 3')
    b.append('ses_1', 'prt_asst', 'msg_asst', 'Assistant reply text')
    expect(b.takeIfFresh('ses_1')).toEqual(['Assistant reply text'])
  })

  it('excludes nothing when a part belongs to the OTHER session\'s user message', () => {
    const b = new TurnBuffer()
    b.markUserMessage('ses_1', 'msg_user_1')
    b.append('ses_2', 'prt_a', 'msg_user_1', 'same messageID, different session')
    expect(b.takeIfFresh('ses_2')).toEqual(['same messageID, different session'])
  })

  it('does not exclude anything before markUserMessage has been called for the session', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'prt_a', 'msg_unknown', 'hello')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello'])
  })

  it('tracks a new user message id on the next turn, no longer excluding the old one', () => {
    const b = new TurnBuffer()
    b.markUserMessage('ses_1', 'msg_turn_1')
    b.append('ses_1', 'prt_a', 'msg_turn_1', 'turn one user text')
    b.takeIfFresh('ses_1') // nothing learned — it was all user text

    b.markUserMessage('ses_1', 'msg_turn_2_user')
    // Turn two's assistant reply carries its own (different) messageID —
    // it must flow through normally, not be excluded as user text.
    b.append('ses_1', 'prt_b', 'msg_turn_2_assistant', 'turn two assistant text')
    expect(b.takeIfFresh('ses_1')).toEqual(['turn two assistant text'])
  })
})
