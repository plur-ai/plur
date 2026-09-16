import { describe, it, expect } from 'vitest'
import { extractLearnings, extractSelfReportedLearnings, isCorrection } from '../src/learner.js'

describe('extractLearnings', () => {
  it('extracts a decision as an architectural candidate with confidence 0.8', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'We decided to use PostgreSQL for the database.' },
    ])
    expect(learnings).toHaveLength(1)
    expect(learnings[0].type).toBe('architectural')
    expect(learnings[0].confidence).toBe(0.8)
  })

  it('extracts an always/never rule as a behavioral candidate with confidence 0.7', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'Always run tests before deploying to production.' },
    ])
    expect(learnings).toHaveLength(1)
    expect(learnings[0].type).toBe('behavioral')
    expect(learnings[0].confidence).toBe(0.7)
    expect(learnings[0].statement).toBe('Always run tests before deploying to production')
  })

  it('extracts a correction phrased as "X, not Y" with confidence 0.8', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'The port is 5433, not 5432.' },
    ])
    expect(learnings).toHaveLength(1)
    expect(learnings[0].type).toBe('behavioral')
    expect(learnings[0].confidence).toBe(0.8)
  })

  it('extracts an identity statement as terminological', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'You are Data, inspired by Star Trek Lieutenant Commander Data' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings[0].type).toBe('terminological')
    expect(learnings[0].confidence).toBe(0.7)
  })

  it('returns nothing for ordinary prose with no learning marker', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'What time is it?' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('ignores assistant messages even when they contain learning-shaped language', () => {
    const learnings = extractLearnings([
      { role: 'assistant', content: 'Always validate inputs at the boundary.' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('ignores messages under the 10-character floor', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'No, use X' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('deduplicates identical statements across messages', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'Always use blue-green deployments for production releases.' },
      { role: 'user', content: 'Always use blue-green deployments for production releases.' },
    ])
    expect(learnings).toHaveLength(1)
  })

  it('extracts learnings from a message that itself quotes a 🧠 I learned: block, without treating the marker line as a learning', () => {
    const learnings = extractLearnings([
      {
        role: 'user',
        content: '🧠 I learned:\n- The API uses snake_case, not camelCase.\n- Always run integration tests before merging.',
      },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(2)
    for (const l of learnings) {
      expect(l.statement.toLowerCase()).not.toContain('i learned')
      expect(l.type).toBe('behavioral')
    }
  })

  it('handles array-of-blocks content, stripping OpenClaw metadata prefixes', () => {
    const learnings = extractLearnings([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Conversation info (untrusted metadata):\n```\nsome meta\n```\nWe decided to always use pnpm for installs.' },
        ],
      },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings.some(l => l.statement.toLowerCase().includes('meta'))).toBe(false)
  })
})

describe('extractLearnings — negation polarity (A1)', () => {
  const stmt = (text: string) => extractLearnings([{ role: 'user', content: text }])[0]?.statement

  it('preserves "never" on a prohibition instead of storing its opposite', () => {
    expect(stmt('never commit the API key to the repo')).toBe('never commit the API key to the repo')
    // Fails if learner.ts reverts to `(?:always|never)\s+(.+)` — group 1
    // would then be "commit the API key to the repo", the literal
    // inversion of the user's prohibition.
  })

  it('preserves "don\'t" on a prohibition', () => {
    expect(stmt("don't push directly to main")).toBe("don't push directly to main")
    // Fails if the capturing group reverts to starting after the directive
    // word — would store "push directly to main".
  })

  it('preserves "do not" on a prohibition', () => {
    expect(stmt('do not delete the production database')).toBe('do not delete the production database')
    // Fails if the capturing group reverts to starting after the directive
    // word — would store "delete the production database".
  })

  it('preserves "never" on a second prohibition', () => {
    expect(stmt('never use force push on shared branches')).toBe('never use force push on shared branches')
    // Fails if the capturing group reverts to starting after the directive
    // word — would store "use force push on shared branches".
  })

  it('keeps the directive word on a positive instruction too, for a consistent contract', () => {
    expect(stmt('always run the tests before committing')).toBe('always run the tests before committing')
    // Fails if the capturing group reverts to starting after the directive
    // word — would store "run the tests before committing" (not an
    // inversion, since this one has no negation, but an inconsistent
    // contract: the fix must keep the directive word for both polarities).
  })
})

describe('extractLearnings — the third inverting pattern (E1)', () => {
  const stmt = (text: string) => extractLearnings([{ role: 'user', content: text }])[0]?.statement

  // These three are the exact inputs measured against the pre-fix built
  // dist: CORRECTION_PATTERNS[1] (`/(.+?),?\s+not\s+(.+)/i`, confidence 0.8)
  // matched any sentence containing " not " — not just a deliberate "X, not
  // Y" contrast — and the extraction code only ever read `match[1]`, the
  // text BEFORE "not". Every one of the five pre-existing A1 tests above
  // avoids the word "not" entirely, which is why they stayed green while
  // this ran unfixed in the shipped package.
  it('does not invert "You should not commit the API key to the repo."', () => {
    // Before the fix: stored "You should" (0.8 conf) — CORRECTION_PATTERNS[1]
    // fired first and swallowed the whole sentence up to "not". Fails if the
    // comma requirement is removed from CORRECTION_PATTERNS[1], OR if
    // PREFERENCE_PATTERNS' "you should" branch (A1) stops capturing the
    // whole match.
    expect(stmt('You should not commit the API key to the repo.'))
      .toBe('You should not commit the API key to the repo')
  })

  it('does not invert "Deploying straight to production is not allowed here."', () => {
    // Before the fix: stored "Deploying straight to production is" (0.8
    // conf) — read under memory-block.ts's "should apply" header, this is
    // the literal opposite of what the user said. No pattern anchors on a
    // bare "is not allowed" construction, so the correct, safe outcome is no
    // candidate at all rather than a guess. Fails if CORRECTION_PATTERNS[1]
    // goes back to matching a bare " not " with no comma required.
    expect(extractLearnings([{ role: 'user', content: 'Deploying straight to production is not allowed here.' }]))
      .toHaveLength(0)
  })

  it('does not invert "That is wrong. The staging database is not a safe place for real customer data."', () => {
    // Before the fix: stored "The staging database is" (0.8 conf) from the
    // second sentence. Fails the same way as the case above.
    expect(extractLearnings([{
      role: 'user',
      content: 'That is wrong. The staging database is not a safe place for real customer data.',
    }])).toHaveLength(0)
  })

  it('preserves the full contrast for a genuine "X, not Y" correction', () => {
    // The pattern's legitimate job, unbroken by the comma requirement:
    // "use pnpm, not npm" has a comma directly before "not". Storing the
    // FULL sentence (not just "use pnpm") is the chosen fix — a fragment
    // reading as an instruction on its own is exactly this bug class. Fails
    // if the capturing group reverts to only the text before "not", or if
    // the comma requirement is tightened further and stops matching this.
    expect(stmt('use pnpm, not npm')).toBe('use pnpm, not npm')
  })

  it('still extracts a bare comma-separated correction with no anchor keyword', () => {
    // Regression guard for the pre-existing "port" test below: the comma
    // discriminator must not be narrowed to isCorrection's anchored
    // "use …"/"it's …" keyword shapes, or a plain "X, not Y" contrast with
    // no keyword anchor (this one) would stop matching entirely.
    expect(stmt('The port is 5433, not 5432.')).toBe('The port is 5433, not 5432')
  })

  // Property-style: no prohibition phrasing in this list may ever produce a
  // statement that reads as the PERMITTED action (the inverted reading).
  // `expected` is either the correctly-signed full statement, or `null` when
  // the safe outcome is "no candidate at all" (no pattern anchors this
  // shape, and guessing would risk an inversion).
  const PROHIBITIONS: Array<{ text: string; expected: string | null; breaksIf: string }> = [
    {
      text: 'never commit the API key to the repo',
      expected: 'never commit the API key to the repo',
      breaksIf: 'PREFERENCE_PATTERNS\' always/never pattern (A1) reverts to capturing only the tail after the directive word',
    },
    {
      text: "don't push directly to main",
      expected: "don't push directly to main",
      breaksIf: 'PREFERENCE_PATTERNS\' you-should/must/don\'t/do-not pattern (A1) reverts to capturing only the tail',
    },
    {
      text: 'do not delete the production database',
      expected: 'do not delete the production database',
      breaksIf: 'PREFERENCE_PATTERNS\' you-should/must/don\'t/do-not pattern (A1) reverts to capturing only the tail',
    },
    {
      text: 'You must not deploy on Friday',
      expected: 'You must not deploy on Friday',
      breaksIf: 'PREFERENCE_PATTERNS\' you-should/must/don\'t/do-not pattern (A1) reverts to capturing only the tail (this one used to survive by string-length accident, not by a correct pattern)',
    },
    {
      text: 'You should not commit the API key to the repo.',
      expected: 'You should not commit the API key to the repo',
      breaksIf: 'CORRECTION_PATTERNS[1] (E1) drops the comma requirement and matches this bare "is not" sentence first, before PREFERENCE_PATTERNS gets a turn',
    },
    {
      text: 'Deploying straight to production is not allowed here.',
      expected: null,
      breaksIf: 'CORRECTION_PATTERNS[1] (E1) drops the comma requirement and matches this bare "is not" sentence',
    },
    {
      text: 'The staging database is not a safe place for real customer data.',
      expected: null,
      breaksIf: 'CORRECTION_PATTERNS[1] (E1) drops the comma requirement and matches this bare "is not" sentence',
    },
    {
      text: 'use pnpm, not npm',
      expected: 'use pnpm, not npm',
      breaksIf: 'CORRECTION_PATTERNS[1] (E1) reverts to capturing only the text before "not" instead of the whole match',
    },
  ]

  for (const { text, expected, breaksIf } of PROHIBITIONS) {
    it(`"${text}" never reads as the permitted action (breaks if: ${breaksIf})`, () => {
      const candidates = extractLearnings([{ role: 'user', content: text }])
      if (expected === null) {
        expect(candidates).toHaveLength(0)
      } else {
        expect(candidates[0]?.statement).toBe(expected)
      }
      // Whether or not a candidate was produced, none of them may equal a
      // reading with the negation word removed — the literal inversion this
      // whole bug class produces.
      const inverted = text.replace(/\b(?:never|not|don't|do not)\s+/gi, '').trim()
      for (const c of candidates) {
        expect(c.statement.toLowerCase()).not.toBe(inverted.toLowerCase())
      }
    })
  }
})

describe('extractSelfReportedLearnings', () => {
  it('extracts bullet points from a well-formed 🧠 I learned: block', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: 'Here is my response.\n\n---\n🧠 I learned:\n- The deploy script needs sudo access.\n- Tests must run before merging.',
    })
    expect(statements).toEqual([
      'The deploy script needs sudo access.',
      'Tests must run before merging.',
    ])
  })

  it('returns an empty array when there is no self-report marker', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: 'Just a normal response with no learning block.',
    })
    expect(statements).toEqual([])
  })

  it('strips -, •, and * bullet markers and trims whitespace', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n* First lesson learned here.\n• Second lesson learned here.\n-   Third lesson learned here.',
    })
    expect(statements).toEqual([
      'First lesson learned here.',
      'Second lesson learned here.',
      'Third lesson learned here.',
    ])
  })

  it('filters out lines under the 10-character floor', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n- ok\n- This one is definitely long enough to keep.',
    })
    expect(statements).toEqual(['This one is definitely long enough to keep.'])
  })

  it('handles array-of-blocks content the same as string content', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: [
        { type: 'text', text: '---\n🧠 I learned:\n- Something learned from array blocks.' },
      ],
    })
    expect(statements).toEqual(['Something learned from array blocks.'])
  })

  it('does not filter by role — the caller decides which message to pass', () => {
    const statements = extractSelfReportedLearnings({
      role: 'user',
      content: '---\n🧠 I learned:\n- Role filtering happens at the call site.',
    })
    expect(statements).toEqual(['Role filtering happens at the call site.'])
  })

  it('drops placeholder bullets copied verbatim from the injected template (A2)', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n- [concise statement of what you learned]\n- [another if applicable]',
    })
    expect(statements).toEqual([])
    // Fails if the placeholder filter is removed — both placeholder strings
    // are well over the 10-character floor, so the length-only filter alone
    // would keep them and hand them to the caller as real learnings.
  })

  it('keeps a real learning alongside a dropped placeholder bullet', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n- [concise statement of what you learned]\n- The deploy script needs sudo access.',
    })
    expect(statements).toEqual(['The deploy script needs sudo access.'])
    // Fails if the placeholder filter over-matches and drops the real bullet
    // too, or under-matches and keeps the placeholder.
  })

  it('does not drop a real bullet that merely starts with a bracket', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n- [ENG-42] the deploy script needs sudo access.',
    })
    expect(statements).toEqual(['[ENG-42] the deploy script needs sudo access.'])
    // Fails if the placeholder filter is broadened to match any line that
    // merely starts with "[" instead of requiring the WHOLE line to be one
    // bracketed span.
  })
})

describe('isCorrection', () => {
  it('flags an explicit correction opener', () => {
    expect(isCorrection({ role: 'user', content: 'No, it should be snake_case' })).toBe(true)
  })

  it('flags an "X, not Y" construction', () => {
    expect(isCorrection({ role: 'user', content: 'Actually, the port is 5433' })).toBe(true)
  })

  it('does not flag ordinary questions', () => {
    expect(isCorrection({ role: 'user', content: 'How do I deploy?' })).toBe(false)
  })

  it('ignores assistant messages regardless of content', () => {
    expect(isCorrection({ role: 'assistant', content: 'No, that is wrong' })).toBe(false)
  })
})
