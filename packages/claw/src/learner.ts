// The learning-extraction heuristics live in `@plur-ai/core` so every plugin
// shares one copy. Re-exported so imports of `./learner.js` keep working.
export { extractLearnings, type LearnCandidate } from '@plur-ai/core'

// The real-time correction gate used by `ingest()`, shared with other plugins.
export { isCorrection } from '@plur-ai/core'
