import { describe, it, expect } from 'vitest'
import { detectCorrection } from '../src/commands/hook-correction-detect.js'

describe('correction detection', () => {
  describe('matches obvious corrections', () => {
    const positives = [
      'no, that\'s wrong',
      'No, what I meant was use Y instead',
      'actually, the right way is to verify the artifact',
      'Actually that\'s not how we do it',
      'wait, what I meant was different',
      'from now on, always use plur_recall_hybrid for factual questions',
      'going forward we don\'t do that',
      'the right way is to read the file first',
      'the correct way to handle this is by checking permissions',
      'I want errors to bubble up not be swallowed',
      'we want explicit confirmation not implicit',
      'don\'t edit files without reading them first',
      'never run rm -rf without confirmation',
      'always verify the artifact before claiming done',
      'must check the existing dependencies first',
      'what I meant was you should run tests after each step',
      'you misunderstood the question',
      'you got that wrong',
      'that\'s not what I asked',
      'remember this: read before edit',
      'note that we don\'t commit on Fridays',
      'the way we do code review here is async',
      'how we do migrations is separately from features',
      'I prefer terse responses',
      'for coding tasks, you should verify the artifact',
      'for refactor tasks you must run tests after each step',
      'let me clarify — I want X not Y',
    ]
    for (const text of positives) {
      it(`matches: "${text}"`, () => {
        const r = detectCorrection(text)
        expect(r.matched).toBe(true)
        expect(r.patterns.length).toBeGreaterThan(0)
      })
    }
  })

  describe('skips false positives', () => {
    const negatives = [
      'no problem, take your time',
      'no worries about that',
      'actually that\'s fine, don\'t worry',
      'actually that works for me',
      'wait a moment please',
      'wait a sec',
      // generic content with no correction pattern
      'can you list the files in the directory?',
      'show me the diff',
      'run the tests',
      'how does the embedding layer work?',
      // brief acknowledgements
      'thanks',
      'ok',
      'sounds good',
    ]
    for (const text of negatives) {
      it(`does not match: "${text}"`, () => {
        const r = detectCorrection(text)
        expect(r.matched).toBe(false)
      })
    }
  })

  describe('edge cases', () => {
    it('empty string returns no match', () => {
      expect(detectCorrection('').matched).toBe(false)
      expect(detectCorrection('   ').matched).toBe(false)
    })

    it('returns the matched substring(s)', () => {
      const r = detectCorrection('Actually, let me clarify what I meant')
      expect(r.matched).toBe(true)
      // multiple patterns may match
      expect(r.patterns.length).toBeGreaterThanOrEqual(1)
    })
  })
})
