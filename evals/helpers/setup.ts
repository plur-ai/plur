// Runs before every eval file. Two jobs:
//  1. Isolation: no eval may read or write the real ~/.plur. Hooks and some
//     loggers use homedir() and ignore PLUR_PATH, so HOME is moved too.
//  2. A clean process state between tests: the embedder cache is process-wide.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach } from 'vitest'
import { resetEmbedder, setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'

const home = mkdtempSync(join(tmpdir(), 'plur-evals-home-'))
const realHome = process.env.HOME
process.env.HOME = home
process.env.USERPROFILE = home
process.env.PLUR_PATH = join(home, '.plur')
// Remote recall is opt-in per eval (team evals use the in-process stub server).
process.env.PLUR_REMOTE_RECALL = process.env.PLUR_REMOTE_RECALL ?? 'off'

afterEach(() => {
  resetEmbedder()
  setEmbeddingsEnabled(true)
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})
