// `extractLearnings` and `LearnCandidate` moved to `@plur-ai/core` (2026-09,
// opencode plugin task 6a) so `@plur-ai/opencode` shares the exact same
// learning-extraction heuristics instead of vendoring a second copy.
// Re-exported here so existing imports of `./learner.js` keep working.
export { extractLearnings, type LearnCandidate } from '@plur-ai/core'

// `isCorrection` moved to `@plur-ai/core` too (2026-09, opencode plugin
// task — A3 parity fix), so `@plur-ai/opencode`'s user-text learning path
// can share the exact same real-time correction gate this package's
// `ingest()` uses, instead of running ungated. Re-exported here so existing
// imports of `./learner.js` (`context-engine.ts`, this package's tests)
// keep working. The old local `extractText`/`splitSentences` helpers moved
// with it — core now owns the only copy. Behaviour is unchanged — claw is a
// shipped package.
export { isCorrection } from '@plur-ai/core'
