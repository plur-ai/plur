/**
 * #1310 — automatic rating of injected engrams from the assistant's reply.
 *
 * One TypeScript implementation of the heuristic plur-hermes has run in
 * Python since #1086, so every editor hook rates the same way. The negative
 * rule is deliberately tighter than the Python one: the old ±100–200 character
 * window around a correction word marked unrelated engrams negative whenever
 * the reply corrected ANYTHING near a shared word. Here the correction word
 * and the engram's distinctive words must sit in the same sentence.
 */
import { describe, it, expect } from 'vitest'
import {
  detectInjectionSignal,
  rateInjectedEngrams,
  AUTO_FEEDBACK_MIN_CONFIDENCE,
} from '../src/injection-signal.js'

const STATEMENT = 'Run the migration script before deploying the billing service'

describe('detectInjectionSignal — positive rules', () => {
  it('exact statement in the reply is positive with high confidence', () => {
    const reply = `Per your notes: ${STATEMENT}. I did that first.`
    const r = detectInjectionSignal(STATEMENT, reply)
    expect(r.signal).toBe('positive')
    expect(r.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('exact match ignores case and whitespace differences', () => {
    const reply = 'Reminder:  run the migration script\nbefore deploying the billing service.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('positive')
  })

  it('high trigram overlap (paraphrase with most phrases intact) is positive', () => {
    // One word changed at the end: most trigrams survive, the exact match fails.
    const reply = 'I will run the migration script before deploying the billing services today.'
    const r = detectInjectionSignal(STATEMENT, reply)
    expect(r.signal).toBe('positive')
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_FEEDBACK_MIN_CONFIDENCE)
    expect(r.confidence).toBeLessThan(0.95)
  })

  it('low trigram overlap is not positive', () => {
    const reply = 'The billing service deployed fine, and the migration can wait.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('a paraphrase sharing 4 or 5 of 7 trigrams (57%, 71%) is not positive (#1365)', () => {
    // The statement has nine words, so seven trigrams. "run the migration
    // script before deploying" holds four of them, "... deploying the" five;
    // the rest of each reply is about something else.
    expect(detectInjectionSignal(STATEMENT, 'I will run the migration script before deploying today.').signal).toBeNull()
    expect(detectInjectionSignal(STATEMENT, 'I will run the migration script before deploying the new mailer.').signal).toBeNull()
  })

  it('an empty statement or reply yields nothing', () => {
    expect(detectInjectionSignal('', 'anything').signal).toBeNull()
    expect(detectInjectionSignal(STATEMENT, '').signal).toBeNull()
  })
})

describe('detectInjectionSignal — negative rule (same sentence)', () => {
  it('a correction word in the same sentence as the engram words is negative', () => {
    const reply = 'Actually, the migration script is not needed before deploying billing anymore.'
    const r = detectInjectionSignal(STATEMENT, reply)
    expect(r.signal).toBe('negative')
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_FEEDBACK_MIN_CONFIDENCE)
  })

  it('a correction in a DIFFERENT sentence does not mark the engram negative', () => {
    // Within 100 characters of the engram words — the old window rule fired here.
    const reply =
      'I ran the migration script and deployed billing. ' +
      'Actually, the CSS bug you mentioned was in the header.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('a correction in one sentence and the engram words in another is nothing (#1365)', () => {
    // Taken together the reply has both a correction phrase and every
    // distinctive word; no single sentence has both.
    const reply =
      'Deploying billing needed the migration script first. ' +
      'The header colour you mentioned, that is wrong: it is blue.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('one shared common word next to a correction is not enough', () => {
    // "service" is the only overlap; one word does not make it about this engram.
    const reply = 'No, the email service was down, not the queue.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('a correction word alone, with none of the engram words, is nothing', () => {
    expect(detectInjectionSignal(STATEMENT, 'That is wrong, sorry.').signal).toBeNull()
  })
})

describe('rateInjectedEngrams', () => {
  it('returns only signals at or above the 0.6 threshold', () => {
    expect(AUTO_FEEDBACK_MIN_CONFIDENCE).toBe(0.6)
    const out = rateInjectedEngrams(
      [
        { id: 'ENG-A', statement: STATEMENT },
        { id: 'ENG-B', statement: 'Prefer tabs over spaces in the legacy parser' },
      ],
      `Following memory: ${STATEMENT}.`,
    )
    expect(out).toEqual([{ id: 'ENG-A', signal: 'positive', confidence: 0.95 }])
  })

  it('skips engrams with no statement', () => {
    expect(rateInjectedEngrams([{ id: 'ENG-A', statement: '' }], 'text')).toEqual([])
  })
})

describe('review fixes (#1318)', () => {
  it('a reply that quotes a memory in order to correct it is never positive', () => {
    const statement = 'use npm for installs'
    const reply = "Your note says 'use npm for installs' — that is no longer true, this repo uses pnpm."
    const r = detectInjectionSignal(statement, reply)
    expect(r.signal).not.toBe('positive')
    expect(r.signal).toBe('negative')
  })

  it('a quote followed by a correction in the NEXT sentence is never positive', () => {
    const reply = `Memory says: ${STATEMENT}. Actually, the migration script was retired last month.`
    expect(detectInjectionSignal(STATEMENT, reply).signal).not.toBe('positive')
  })

  it('a paraphrase (trigram match) that is then corrected is never positive', () => {
    const reply = 'You said to run the migration script before deploying the billing services. That is outdated now.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).not.toBe('positive')
  })

  it('a quote with an unrelated correction two sentences later stays positive', () => {
    const reply = `${STATEMENT}. I did that. The tests passed. Actually, the CSS bug was in the header.`
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('positive')
  })

  it('a statement under three words needs the words adjacent, not just present', () => {
    expect(detectInjectionSignal('Prefer pnpm', 'I prefer to keep pnpm out of this one.').signal).toBeNull()
    // A short reply degrades to bare words too — the words, in any order, matched.
    expect(detectInjectionSignal('Prefer pnpm', 'pnpm? prefer').signal).toBeNull()
    expect(detectInjectionSignal('Prefer pnpm', 'As noted: prefer pnpm. Done.').signal).toBe('positive')
  })

  it('"what is wrong" in ordinary prose is not a correction', () => {
    const reply = 'Let me check what is wrong with the migration script before deploying.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('an agreeing reply that merely opens with "Actually," or "No," is not a correction (audit M3)', () => {
    const statement = 'Always run pnpm build before running the claw tests'
    expect(detectInjectionSignal(statement, 'Actually, let me also run the claw tests right after the pnpm build.').signal).not.toBe('negative')
    expect(detectInjectionSignal(statement, 'No, the claw tests passed after the pnpm build, all green.').signal).not.toBe('negative')
  })

  it('a leading "Actually," that does contradict the engram still counts', () => {
    const statement = 'Always run pnpm build before running the claw tests'
    expect(detectInjectionSignal(statement, 'Actually, the claw tests no longer need a pnpm build first.').signal).toBe('negative')
    expect(detectInjectionSignal(statement, "No, the claw tests don't need the pnpm build anymore.").signal).toBe('negative')
  })

  it('a correction aimed at a prior claim still counts', () => {
    const reply = 'That is wrong now: the migration script before deploying billing was dropped.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('negative')
  })
})

describe('a match rejected where it sits is never positive (#1362)', () => {
  it('a quoted statement called outdated right after the quote is negative', () => {
    const r = detectInjectionSignal(STATEMENT, `"${STATEMENT}" is outdated.`)
    expect(r.signal).toBe('negative')
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_FEEDBACK_MIN_CONFIDENCE)
  })

  it('"Your note says X, but that is wrong since v3" is negative', () => {
    const reply = `Your note says ${STATEMENT}, but that is wrong since v3.`
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('negative')
  })

  it('"Do not use pnpm, use npm." against the engram "Use pnpm" is negative', () => {
    expect(detectInjectionSignal('Use pnpm', 'Do not use pnpm, use npm.').signal).toBe('negative')
    expect(detectInjectionSignal('Use pnpm', 'Don’t ever use pnpm here; use npm.').signal).toBe('negative')
  })

  it('a negated paraphrase (trigram match) is negative', () => {
    const reply = 'You should never run the migration script before deploying the billing services now.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('negative')
  })

  it('a correction written with a curly apostrophe counts (“that’s wrong”)', () => {
    const reply = 'Your note says “use pnpm” — that’s wrong now.'
    expect(detectInjectionSignal('Use pnpm', reply).signal).toBe('negative')
    expect(detectInjectionSignal('Use pnpm', reply.replace('’', 'ʼ')).signal).toBe('negative')
    expect(detectInjectionSignal('Use pnpm', reply.replace('’', "'")).signal).toBe('negative')
  })

  it('an engram statement written with a curly apostrophe matches a straight one (#1365)', () => {
    expect(detectInjectionSignal('Don\u2019t use npm', "Right: don't use npm here.").signal).toBe('positive')
    expect(detectInjectionSignal('Don\u02bct use npm', 'Right: don\u2019t use npm here.').signal).toBe('positive')
  })

  it('a reply that follows the engram with an unrelated "not" stays positive', () => {
    expect(detectInjectionSignal('Use pnpm', 'Use pnpm, not npm.').signal).toBe('positive')
    expect(detectInjectionSignal('Use pnpm', 'If not sure, use pnpm.').signal).toBe('positive')
    const reply = `I did not skip anything: ${STATEMENT}, which is not optional.`
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('positive')
  })
})

describe('one rejected occurrence does not override a follow-through one (#1362)', () => {
  it('a statement first negated, then carried out, gets no verdict', () => {
    const reply = `I did not ${STATEMENT.toLowerCase()} yet \u2014 doing it now: ${STATEMENT}.`
    // Mixed occurrences get no verdict: neither negative nor positive.
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('following the engram and then ruling out a variant of it is not negative', () => {
    expect(detectInjectionSignal('Use pnpm', 'Use pnpm. Never use pnpm with sudo, though.').signal).not.toBe('negative')
    expect(detectInjectionSignal('Use pnpm', 'Use pnpm. Do not use pnpm dlx for this script.').signal).not.toBe('negative')
  })

  it('each run of trigrams is judged on its own', () => {
    const reply =
      "Don't run the migration script now. " +
      'Later, run the migration script before deploying the billing services.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).not.toBe('negative')
  })

  it('a negator ending the previous sentence does not negate the match (#1365)', () => {
    expect(detectInjectionSignal('Use pnpm', 'I will not. Use pnpm.').signal).toBe('positive')
  })

  it('"Why not use pnpm?" recommends it, so it is not negative', () => {
    expect(detectInjectionSignal('Use pnpm', 'Why not use pnpm?').signal).not.toBe('negative')
  })

  it('every occurrence rejected is still negative', () => {
    expect(detectInjectionSignal('Use pnpm', 'Do not use pnpm. Never use pnpm here.').signal).toBe('negative')
  })
})

describe('more ways of setting a match aside (#1362)', () => {
  const S = 'use pnpm for installs'
  it.each([
    'We no longer use pnpm for installs.',
    'Instead of "use pnpm for installs", use npm.',
    'Rather than use pnpm for installs, switch to npm.',
    'The memory "use pnpm for installs" does not apply to this repo.',
    "The memory \u201cuse pnpm for installs\u201d doesn\u2019t apply here.",
    'The rule use pnpm for installs was dropped last month.',
    'The rule use pnpm for installs has been removed.',
    'Ignore "use pnpm for installs"; this repo uses npm.',
  ])('%s is negative', reply => {
    expect(detectInjectionSignal(S, reply).signal).toBe('negative')
  })

  it.each([
    'Use pnpm for installs instead of npm.',
    'Rather than npm, use pnpm for installs.',
    'Use pnpm for installs; it no longer breaks on workspaces.',
    'Stop \u2014 use pnpm for installs.',
  ])('%s stays positive', reply => {
    expect(detectInjectionSignal(S, reply).signal).toBe('positive')
  })
})

describe('stays linear on long replies (#1362)', () => {
  const MIB = 1024 * 1024
  const time = (fn: () => unknown): number => { const t = performance.now(); fn(); return performance.now() - t }

  it('a 1 MiB reply of repeated matches with no sentence break rates in under 1 s', () => {
    const reply = 'use pnpm '.repeat(Math.ceil(MIB / 9))
    let r: ReturnType<typeof detectInjectionSignal> | undefined
    const ms = time(() => { r = detectInjectionSignal('Use pnpm', reply) })
    expect(r!.signal).toBe('positive')
    expect(ms).toBeLessThan(1000)
  }, 30_000)

  it('a 1 MiB reply of long sentences full of matches, the last one corrected, rates in under 1 s', () => {
    const sentence = 'use pnpm '.repeat(Math.ceil(MIB / 9 / 16)) + 'done.\n'
    const reply = sentence.repeat(15) + 'use pnpm. That is wrong now.'
    let r: ReturnType<typeof detectInjectionSignal> | undefined
    const ms = time(() => { r = detectInjectionSignal('Use pnpm', reply) })
    // Fifteen clean sentences and one corrected occurrence: they disagree.
    expect(r!.signal).toBeNull()
    expect(ms).toBeLessThan(1000)
  }, 30_000)
})
