// PRV-5: A memory saved to a team scope without saying whether it is private is kept on my machine until I say it may be shared.
//
// today: broken (decide pending in promises.yaml). This eval states the
// promise as written: a team-scope save with no visibility is kept locally and
// nothing reaches the team server. The control (visibility: 'public', i.e. I
// said it may be shared) proves the path does push when cleared.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, waitFor, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const UNSAID = 'the on-call rotation swaps every second Thursday'
const CLEARED = 'the on-call handbook lives in the team wiki'

describe('PRV-5 a team-scope memory with no visibility stays on my machine until I clear it', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(() => { s?.cleanup(); s = undefined })

  for (const method of ['learn', 'learnRouted'] as const) {
    it(`${method}(): team scope, no visibility`, async () => {
      s = await teamStore(t.url)
      const saved = await s.plur[method](UNSAID, { scope: TEAM_SCOPE })
      await s.plur[method](CLEARED, { scope: TEAM_SCOPE, visibility: 'public' })
      const clearedArrived = await waitFor(() => t.stub.appendCountFor(CLEARED) === 1)
      expect(clearedArrived, 'precondition: a team memory I cleared for sharing (visibility public) reached the team server').toBe(true)
      expect(t.stub.appendCountFor(UNSAID),
        'expected a team-scope memory saved without a visibility to stay on this machine; it was sent to the team server').toBe(0)
      const local = (await s.plur.list()).find(e => e.statement === UNSAID)
      expect(local?.id ?? null, `expected the memory (${saved.id}) to be kept in the local store`).not.toBeNull()
    })
  }
})
