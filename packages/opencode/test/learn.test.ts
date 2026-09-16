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

  // D3 (2026-09 audit): learnFromUserText already gated on auto_learn;
  // learnFromTurn — the path an attacker can actually write through, since
  // it harvests the ASSISTANT's own text, which can quote a hostile
  // file/webpage the agent was asked to summarize — did not. Claw gates
  // both of its equivalent paths (context-engine.ts) the same way.
  it('respects the auto_learn: false kill switch (D3)', async () => {
    const plur = { config: { auto_learn: false }, learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, ['---\n🧠 I learned:\n- Something worth remembering here.'])
    expect(plur.learnRouted).not.toHaveBeenCalled()
    // Fails if the `plur.config?.auto_learn === false` check is removed —
    // this is an unambiguous self-report that would otherwise persist.
  })

  it('learns normally when auto_learn is explicitly true or unset', async () => {
    const plur = { config: { auto_learn: true }, learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, ['---\n🧠 I learned:\n- Something worth remembering here.'])
    expect(plur.learnRouted).toHaveBeenCalledTimes(1)

    const plurNoConfig = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plurNoConfig, ['---\n🧠 I learned:\n- Something worth remembering here.'])
    expect(plurNoConfig.learnRouted).toHaveBeenCalledTimes(1)
  })

  // D5 (#963, 2026-09 audit): every statement this path writes is the
  // agent's own extraction, not a verbatim human assertion — mark it so
  // (formatLayer3 renders `(inferred)` / `Kind: inferred`), so it can never
  // be mistaken for something explicitly taught via plur_learn.
  it('marks every self-reported statement claim_class: inferred (D5)', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromTurn(plur, ['---\n🧠 I learned:\n- The deploy script needs sudo access.'])
    expect(plur.learnRouted).toHaveBeenCalledWith(
      'The deploy script needs sudo access.',
      expect.objectContaining({ claim_class: 'inferred' }),
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

  it('drops text with no correction marker before confidence is even considered (A3 gate)', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    // "I prefer X" has no correction marker ("no,", "actually,", "wrong",
    // "X, not Y") — isCorrection() rejects it before extractLearnings runs.
    await learnFromUserText(plur, 'I prefer shorter status updates over verbose ones.')
    expect(plur.learnRouted).not.toHaveBeenCalled()
    // Fails if the isCorrection() gate in learnFromUserText is removed —
    // this text would then reach extractLearnings, whose "i prefer" pattern
    // matches it (at 0.6 confidence, still below the persist gate, but for
    // the wrong reason — see the next test for that gate in isolation).
  })

  it('still enforces the 0.7 confidence gate once the correction gate passes', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    // Starts with "wrong" — passes isCorrection() — but the sentence only
    // matches the "you should" pattern group, which scores 0.6.
    await learnFromUserText(plur, 'Wrong, you should use four spaces for indentation.')
    expect(plur.learnRouted).not.toHaveBeenCalled()
    // Fails if the `candidate.confidence < 0.7` check is removed — this
    // candidate clears isCorrection() and extractLearnings, so only the
    // confidence gate stands between it and being persisted.
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

  it('respects the auto_learn: false kill switch even for a clear correction (A3 switch)', async () => {
    const plur = { config: { auto_learn: false }, learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromUserText(plur, 'No, the API uses snake_case not camelCase.')
    expect(plur.learnRouted).not.toHaveBeenCalled()
    // Fails if the `plur.config?.auto_learn === false` check is removed —
    // this text is an unambiguous correction that would otherwise persist.
  })

  it('learns normally when auto_learn is explicitly true', async () => {
    const plur = { config: { auto_learn: true }, learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromUserText(plur, 'No, the API uses snake_case not camelCase.')
    expect(plur.learnRouted).toHaveBeenCalledTimes(1)
    // Fails if the switch check is inverted (e.g. `=== true` required to
    // proceed) — the default-true contract would break for a real Plur
    // instance whose config happens to be read some other way.
  })

  // D5 (#963, 2026-09 audit): the STATEMENT is this plugin's own regex
  // extraction from the user's text, not a verbatim quote — mark it inferred
  // the same as the self-report path, so it renders as `(inferred)` rather
  // than reading like something explicitly taught.
  it('marks every extracted correction claim_class: inferred (D5)', async () => {
    const plur = { learnRouted: vi.fn().mockResolvedValue({}) }
    await learnFromUserText(plur, 'No, the API uses snake_case not camelCase.')
    expect(plur.learnRouted).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ claim_class: 'inferred' }),
    )
  })
})
