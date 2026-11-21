/**
 * #1832 — the release announcement's update line installs the latest version
 * globally and then runs `plur init`. The global install alone does not move
 * an npx entry, which records an exact @plur-ai/mcp version (never @latest,
 * #1069); `plur init` moves that pin.
 *
 * Runs `generate_tweet` from scripts/release.sh itself (extracted with its
 * `char_count` helper), against a temp CHANGELOG, so the test reads the reply
 * the release would post.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const RELEASE = join(__dirname, '..', '..', '..', 'scripts', 'release.sh')

/** The shell function `name` from release.sh, from its header to its closing brace. */
function shellFunction(src: string, name: string): string {
  const start = src.indexOf(`\n${name}() {`)
  if (start === -1) throw new Error(`${name} not found in release.sh`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start + 1, end + 2)
}

describe.skipIf(process.platform === 'win32')('release reply update line (#1832)', () => {
  it('installs latest globally and runs plur init, within the reply budget', () => {
    const src = readFileSync(RELEASE, 'utf8')
    const dir = mkdtempSync(join(tmpdir(), 'plur-reply-1832-'))
    try {
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 9.9.9\n\nA release.\n\n- One change.\n')
      const script = `${shellFunction(src, 'char_count')}\n${shellFunction(src, 'generate_tweet')}\nVERSION=9.9.9\ngenerate_tweet\nprintf '%s\\n---LEN---\\n%s' "$REPLY" "$REPLY_LEN"`
      const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf-8' })
      expect(r.status, r.stderr).toBe(0)
      const [reply, len] = r.stdout.split('\n---LEN---\n')
      expect(reply).toContain('npm i -g @plur-ai/cli@latest @plur-ai/mcp@latest && plur init')
      expect(reply).not.toContain('npm update -g')
      expect(Number(len)).toBeLessThanOrEqual(270)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
