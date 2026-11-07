/**
 * Security audit 2026-11-06 (hardening): typedText() removed echo spans with
 * ECHO_SPAN, a regex whose lazy body and `[^>]*` both rescan to the end of
 * the text from every unclosed opener, before any size bound: quadratic in
 * the message (200k characters of unclosed tags took 0.3 s, of openers
 * without '>' about 3 s). The text is now bounded to its last 200k characters
 * first, and spans are removed by a linear scanner with the regex's results.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { lastUserMessage, stripEchoSpans } from '../src/lib/learn-signal.js'

const ECHO_SPAN = /<(command-name|command-message|command-args|local-command-[a-z-]+|bash-[a-z-]+|task-notification|system-reminder|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g

let dirs: string[] = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function transcriptWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-echo-'))
  dirs.push(dir)
  const p = join(dir, 't.jsonl')
  writeFileSync(p, JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: text } }) + '\n')
  return p
}

describe('learn-signal echo-span removal stays linear (security audit 2026-11-06)', () => {
  it('200k chars of unclosed echo tags finish in under 200 ms', () => {
    const text = '<system-reminder>'.repeat(Math.ceil(200_000 / 17)).slice(0, 200_000)
    const p = transcriptWith(text)
    const t0 = performance.now()
    lastUserMessage(p)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('200k chars of openers with no closing ">" finish in under 200 ms', () => {
    const text = 'no, use pnpm ' + '<bash-a '.repeat(25_000)
    const p = transcriptWith(text)
    const t0 = performance.now()
    lastUserMessage(p)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('a 200k-char tag name with a long unmatched closer finishes in under 200 ms', () => {
    const run = 'a-'.repeat(50_000)
    const text = `<bash-${run}x>` + `</bash-${run}b>`
    const t0 = performance.now()
    const out = stripEchoSpans(text)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(out).toBe(text)
  })

  it('removes exactly what the echo-span regex removes', () => {
    const cases = [
      'plain typed text',
      '<command-name>/clear</command-name> no, use pnpm',
      '<system-reminder>a</system-reminder>typed<system-reminder>b</system-reminder>',
      '<system-reminder x="1">open only',
      '<bash-input>ls</bash-input><bash-stdout>out</bash-stdout> keep',
      '<bash-a-b>x</bash-a> y</bash-a-b> z',
      '<bash-foo- >x</bash-foo> tail',
      '<local-command-stdout>x</local-command-stdout>',
      '<local-command-a-b c>x</local-command-a> y',
      '<task-notification><system-reminder>in</system-reminder></task-notification> after',
      '<system-reminderx>not a tag</system-reminderx>',
      '<user-prompt-submit-hook>h</user-prompt-submit-hook><command-args>a</command-args>',
      '<bash-A>upper</bash-A> <bash-x_y>u</bash-x> <bash-9>d</bash-9>',
      '<bash-a>one</bash-a>two</bash-a>',
      '<<system-reminder>>x</system-reminder>>',
      '<bash-->x</bash--> <bash-a->y</bash-a> <bash-a->z</bash-a->',
    ]
    for (const c of cases) expect(stripEchoSpans(c), c).toBe(c.replace(ECHO_SPAN, ''))

    // Random mixes of the building blocks, compared against the regex.
    const parts = ['<bash-a>', '</bash-a>', '<bash-a-b ', '</bash-a-b>', '>', '<system-reminder>', '</system-reminder>',
      '<command-name x>', '</command-name>', 'text ', '-', 'b', '<', '</', '<local-command-x>', '</local-command-x>', ' ']
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    for (let n = 0; n < 3000; n++) {
      let s = ''
      const len = 1 + Math.floor(rnd() * 12)
      for (let i = 0; i < len; i++) s += parts[Math.floor(rnd() * parts.length)]
      expect(stripEchoSpans(s), JSON.stringify(s)).toBe(s.replace(ECHO_SPAN, ''))
    }
  })

  it('still returns the typed words around echo spans', () => {
    const p = transcriptWith('<command-name>/x</command-name>no, use pnpm instead')
    expect(lastUserMessage(p)?.text).toBe('no, use pnpm instead')
  })
})
