import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  hasLearnSignal,
  lastUserMessage,
  learnFallbackInterval,
  TRANSCRIPT_TAIL_BYTES,
} from '../src/lib/learn-signal.js'

describe('hasLearnSignal — corrections, preferences, decisions', () => {
  const signals = [
    'no, use pnpm not npm',
    'No. That is the wrong file.',
    'Nope, revert that',
    'Actually, put it in the lib folder',
    'That works. Actually let us keep the old name.',
    "don't add a new dependency for this",
    'Do not commit to main',
    'Never print the token',
    'Always run the typecheck before you commit',
    'from now on write tests first',
    'Going forward, keep PR bodies short',
    'I prefer tabs',
    "I'd rather you asked first",
    'use the existing helper instead',
    'you should have used the broker',
    "you shouldn't push to main",
    'it should be in the cli package',
    "that's wrong",
    'That is not right, the port is 8080',
    'not what I asked for',
    'Saved: /Users/x/Downloads/triage.decisions.json',
    'apply decisions',
    'Please apply the decisions from the board',
    'Please don\'t touch the lockfile',
    'STOP editing that file',
  ]
  for (const text of signals) {
    it(`signals: ${JSON.stringify(text)}`, () => {
      expect(hasLearnSignal(text)).toBe(true)
    })
  }

  const plain = [
    'what does this function do?',
    'can you run the tests',
    'why does the build not work?',
    "why don't the tests pass?",
    'should I use pnpm or npm here?',
    'what does it actually return?',
    'is there a way to do this instead?',
    'no problem, carry on',
    'No worries — next, open the PR',
    'Nothing else for now',
    'Notes are in the docs folder, summarise them',
    'never mind, let us move on',
    'please summarise the changelog',
    'ok',
    '',
  ]
  for (const text of plain) {
    it(`no signal: ${JSON.stringify(text)}`, () => {
      expect(hasLearnSignal(text)).toBe(false)
    })
  }

  it('is case-insensitive', () => {
    expect(hasLearnSignal('FROM NOW ON use yaml')).toBe(true)
    expect(hasLearnSignal('i PREFER spaces')).toBe(true)
  })
})

describe('lastUserMessage — reads the last human prompt from a Claude Code transcript', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function transcript(lines: unknown[], raw = ''): string {
    dir = mkdtempSync(join(tmpdir(), 'plur-learn-signal-'))
    const path = join(dir, 't.jsonl')
    writeFileSync(path, raw + lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return path
  }

  const human = (content: unknown, extra: Record<string, unknown> = {}) =>
    ({ type: 'user', uuid: `u-${Math.random()}`, message: { role: 'user', content }, ...extra })
  const assistant = (text: string) =>
    ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const toolResult = () =>
    ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'output' }] } })

  it('returns the last human message, skipping tool results and assistant turns after it', () => {
    const path = transcript([
      human('first question'),
      assistant('answer'),
      human('no, use the other file', { uuid: 'want' }),
      assistant('calling a tool'),
      toolResult(),
      assistant('done'),
    ])
    expect(lastUserMessage(path)).toEqual({ id: 'want', text: 'no, use the other file' })
  })

  it('reads text blocks from array content', () => {
    const path = transcript([human([{ type: 'text', text: 'I prefer ' }, { type: 'text', text: 'yaml' }], { uuid: 'arr' })])
    expect(lastUserMessage(path)?.text).toBe('I prefer \nyaml')
  })

  it('skips meta lines, sidechains and non-human origins (task notifications, peers)', () => {
    const path = transcript([
      human('never push to main', { uuid: 'real', origin: { kind: 'human' } }),
      human('<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }),
      human('caveat text', { isMeta: true }),
      human('sidechain prompt', { isSidechain: true }),
      human('peer says hi', { origin: { kind: 'peer' } }),
    ])
    expect(lastUserMessage(path)?.id).toBe('real')
  })

  it('tolerates a torn first line and garbage lines', () => {
    const path = transcript([human('always use pnpm', { uuid: 'ok' }), assistant('sure')], '{"type":"us\nnot json\n')
    expect(lastUserMessage(path)?.id).toBe('ok')
  })

  it('returns null — never throws — for a missing, empty, directory or non-string path', () => {
    expect(lastUserMessage('/nonexistent/plur/transcript.jsonl')).toBeNull()
    expect(lastUserMessage('')).toBeNull()
    expect(lastUserMessage(undefined)).toBeNull()
    expect(lastUserMessage(42)).toBeNull()
    dir = mkdtempSync(join(tmpdir(), 'plur-learn-signal-'))
    mkdirSync(join(dir, 'd'))
    expect(lastUserMessage(join(dir, 'd'))).toBeNull()
    writeFileSync(join(dir, 'empty.jsonl'), '')
    expect(lastUserMessage(join(dir, 'empty.jsonl'))).toBeNull()
  })

  it('reads only a bounded tail of a large transcript', () => {
    // The old message sits before the tail window; only filler follows within it.
    const filler = assistant('x'.repeat(1024))
    const n = Math.ceil(TRANSCRIPT_TAIL_BYTES / 1024) + 10
    const path = transcript([human('from now on use tabs', { uuid: 'far' }), ...Array.from({ length: n }, () => filler)])
    expect(lastUserMessage(path)).toBeNull()
  })
})

describe('learnFallbackInterval', () => {
  it('defaults to 20', () => expect(learnFallbackInterval({})).toBe(20))
  it('reads PLUR_LEARN_FALLBACK_INTERVAL', () => expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: '5' })).toBe(5))
  it('0 disables the fallback', () => expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: '0' })).toBe(0))
  it('garbage falls back to the default', () => {
    expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: 'abc' })).toBe(20)
    expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: '-3' })).toBe(20)
  })
})
