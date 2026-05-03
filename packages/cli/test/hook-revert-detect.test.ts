import { describe, it, expect } from 'vitest'
import { detectRevert } from '../src/commands/hook-revert-detect.js'

describe('revert detection', () => {
  describe('matches revert-style commands', () => {
    const cases: Array<[string, string]> = [
      ['git checkout file.txt', 'git checkout'],
      ['git checkout -- src/foo.ts', 'git checkout'],
      ['git checkout HEAD~1 -- file', 'git checkout'],
      ['git reset --hard origin/main', 'git reset --hard'],
      ['git reset --hard HEAD~3', 'git reset --hard'],
      ['git restore file.ts', 'git restore'],
      ['git restore --staged file.ts', 'git restore'],
      ['git revert HEAD', 'git revert'],
      ['git revert abc1234', 'git revert'],
      ['git stash drop stash@{0}', 'git stash drop'],
      ['git stash clear', 'git stash drop'],
    ]
    for (const [cmd, desc] of cases) {
      it(`detects: ${cmd}`, () => {
        const r = detectRevert('Bash', cmd)
        expect(r.matched).toBe(true)
        expect(r.description).toBe(desc)
      })
    }
  })

  describe('skips intended workflow commands', () => {
    const negatives = [
      'git checkout -b feature-branch',
      'git checkout main',
      'git checkout master',
      'git checkout develop',
      'git status',
      'git log --oneline -5',
      'git add .',
      'git commit -m "feat: add x"',
      'git push origin main',
      'git pull --rebase',
      'ls -la',
      'cd /tmp && pwd',
    ]
    for (const text of negatives) {
      it(`does not match: ${text}`, () => {
        const r = detectRevert('Bash', text)
        expect(r.matched).toBe(false)
      })
    }
  })

  describe('only fires on Bash tool', () => {
    it('ignores non-Bash tool with revert-looking content', () => {
      const r = detectRevert('Edit', 'git checkout -- file')
      expect(r.matched).toBe(false)
    })

    it('ignores Read tool', () => {
      const r = detectRevert('Read', 'git reset --hard')
      expect(r.matched).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('empty command returns no match', () => {
      expect(detectRevert('Bash', '').matched).toBe(false)
      expect(detectRevert('Bash', '   ').matched).toBe(false)
    })

    it('returns the trimmed command on match', () => {
      const r = detectRevert('Bash', '  git revert HEAD  ')
      expect(r.matched).toBe(true)
      expect(r.command).toBe('git revert HEAD')
    })
  })
})
