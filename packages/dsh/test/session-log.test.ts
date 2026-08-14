import { describe, expect, it } from 'vitest'
import { lastAssistantText, recallQueryFrom, type LogEvent } from '../src/session-log.ts'

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })
const userMsg = (t: string, time: number): LogEvent =>
  ({ type: 'user/message', time, data: { ...text(t), source: { kind: 'user' } } })
const turnStart = (turn: number, time: number): LogEvent =>
  ({ type: 'turn/start', time, data: { turn } })

describe('recallQueryFrom', () => {
  it('uses only the user messages entered in the current turn', () => {
    const events = [turnStart(1, 1), userMsg('older', 2), turnStart(2, 3), userMsg('current', 4)]
    expect(recallQueryFrom(events, 2, [])).toBe('current')
  })

  it('includes messages proposed by the pre-step decision', () => {
    expect(recallQueryFrom([turnStart(1, 1)], 1, [text('proposed')])).toBe('proposed')
  })

  it('ignores plugin-sourced context so recall never drifts onto its own output', () => {
    const events: LogEvent[] = [
      turnStart(1, 1),
      { type: 'user/message', time: 2, data: { ...text('plugin noise'), source: { kind: 'plugin', plugin: 'plur' } } },
      userMsg('real ask', 3),
    ]
    expect(recallQueryFrom(events, 1, [])).toBe('real ask')
  })

  it('joins several user messages in one turn', () => {
    const events = [turnStart(1, 1), userMsg('first', 2), userMsg('second', 3)]
    expect(recallQueryFrom(events, 1, [])).toBe('first\nsecond')
  })

  it('returns empty string when the turn has no user text', () => {
    expect(recallQueryFrom([turnStart(1, 1)], 1, [])).toBe('')
  })

  it('returns empty string when the turn never started', () => {
    expect(recallQueryFrom([], 7, [])).toBe('')
  })

  it('tolerates malformed content without throwing', () => {
    const events: LogEvent[] = [
      turnStart(1, 1),
      { type: 'user/message', time: 2, data: { content: 'not-an-array', source: { kind: 'user' } } },
      { type: 'user/message', time: 3, data: null },
    ]
    expect(recallQueryFrom(events, 1, [])).toBe('')
  })
})

describe('lastAssistantText', () => {
  it('returns the most recent assistant message text', () => {
    const events: LogEvent[] = [
      { type: 'assistant/message', time: 1, data: { message: text('first') } },
      { type: 'assistant/message', time: 2, data: { message: text('second') } },
    ]
    expect(lastAssistantText(events)).toBe('second')
  })

  it('skips an empty assistant message and finds the last one with text', () => {
    const events: LogEvent[] = [
      { type: 'assistant/message', time: 1, data: { message: text('real') } },
      { type: 'assistant/message', time: 2, data: { message: { content: [] } } },
    ]
    expect(lastAssistantText(events)).toBe('real')
  })

  it('returns undefined when there is none', () => {
    expect(lastAssistantText([])).toBeUndefined()
  })
})
