/**
 * The release summary ends with the follow-up step a person still has to take:
 * @plur-ai/plur-enterprise bundles the client, is published by hand from its
 * own repository, and keeps installing the previous client until it is.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const RELEASE = join(__dirname, '..', '..', '..', 'scripts', 'release.sh')

describe('release summary next steps', () => {
  it('reminds the releaser to rebuild @plur-ai/plur-enterprise after the summary', () => {
    const src = readFileSync(RELEASE, 'utf8')
    const summary = src.indexOf('=== Release v$VERSION complete ===')
    expect(summary).toBeGreaterThan(-1)
    const after = src.slice(summary)
    expect(after).toMatch(/echo "Next:/)
    expect(after).toContain('@plur-ai/plur-enterprise')
  })
})
