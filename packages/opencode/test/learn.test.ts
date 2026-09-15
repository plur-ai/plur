import { describe, it, expect, vi } from 'vitest'
import { learnFromTurn, learnFromUserText } from '../src/learn.js'

describe('learnFromTurn — self-report path (primary)', () => {
  it('persists each bullet of a 🧠 I learned: block found in the turn text', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, [
      'Working on it...',
      '\n\n---\n🧠 I learned:\n- The deploy script needs sudo access.\n- Tests must run before merging.',
    ])

    expect(plur.learnRouted).toHaveBeenCalledTimes(2)
    expect(plur.learnRouted).toHaveBeenCalledWith(
      'The deploy script needs sudo access.',
      expect.objectContaining({ type: 'behavioral', source: 'opencode:self-report', tags: ['self-report'] }),
    )
    expect(plur.learnRouted).toHaveBeenCalledWith(
      'Tests must run before merging.',
      expect.objectContaining({ type: 'behavioral', source: 'opencode:self-report', tags: ['self-report'] }),
    )
  })

  it('does not read a context field off the candidate (LearnCandidate has none)', async () => {
    // Regression guard for the brief's Step 5 defect: LearnCandidate is
    // {statement, type, confidence} with no `context` field. Self-report
    // statements are plain strings, so this is naturally safe — assert the
    // call shape stays a (statement, LearnContext) pair.
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, ['---\n🧠 I learned:\n- Something worth remembering here.'])
    expect(plur.learnRouted).toHaveBeenCalledWith('Something worth remembering here.', expect.any(Object))
  })

  it('does nothing when the turn has no self-report block', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, ['Just a normal response.'])
    expect(plur.learnRouted).not.toHaveBeenCalled()
  })

  it('joins multiple accumulated chunks before extracting', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, ['first chunk', '---', '🧠 I learned:', '- Chunks join with newlines correctly.'])
    expect(plur.learnRouted).toHaveBeenCalledWith(
      'Chunks join with newlines correctly.',
      expect.any(Object),
    )
  })
})

describe('learnFromUserText — correction path (secondary)', () => {
  it('persists a high-confidence correction from the user turn text', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromUserText(plur, 'No, the API uses snake_case not camelCase.')

    expect(plur.learnRouted).toHaveBeenCalledTimes(1)
    const [statement, context] = plur.learnRouted.mock.calls[0]
    expect(typeof statement).toBe('string')
    expect(context).toMatchObject({ source: 'opencode:chat.message' })
  })

  it('drops candidates below the 0.7 confidence gate', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    // "I prefer X" patterns score 0.6 confidence — below the persist gate.
    await learnFromUserText(plur, 'I prefer shorter status updates over verbose ones.')
    expect(plur.learnRouted).not.toHaveBeenCalled()
  })

  it('does nothing for ordinary text with no correction/preference marker', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromUserText(plur, 'What time is it?')
    expect(plur.learnRouted).not.toHaveBeenCalled()
  })

  it('does nothing for empty text', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromUserText(plur, '')
    expect(plur.learnRouted).not.toHaveBeenCalled()
  })
})
