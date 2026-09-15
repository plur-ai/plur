import { describe, it, expect } from 'vitest'
import { TurnBuffer } from '../src/turn.js'

describe('TurnBuffer', () => {
  it('accumulates assistant text per session', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'hello')
    b.append('ses_1', 'world')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello', 'world'])
  })

  it('returns undefined on a second take — session.idle fires twice', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'hello')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello'])
    expect(b.takeIfFresh('ses_1')).toBeUndefined()
  })

  it('becomes fresh again when the next turn appends', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'turn one')
    b.takeIfFresh('ses_1')
    b.append('ses_1', 'turn two')
    expect(b.takeIfFresh('ses_1')).toEqual(['turn two'])
  })

  it('ignores empty text', () => {
    const b = new TurnBuffer()
    b.append('ses_1', '')
    expect(b.takeIfFresh('ses_1')).toBeUndefined()
  })
})
