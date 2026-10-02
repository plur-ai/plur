import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  hasLearnSignal,
  lastUserMessage,
  learnFallbackInterval,
  claimNudge,
  normaliseForSignal,
  TRANSCRIPT_TAIL_BYTES,
} from '../src/lib/learn-signal.js'

describe('hasLearnSignal — corrections, preferences, decisions', () => {
  const signals = [
    'no, use pnpm not npm',
    'No. That is the wrong file.',
    'Nope, revert that',
    "don't add a new dependency for this",
    'Do not commit to main',
    'Never print the token',
    'Always run the typecheck before you commit',
    'from now on write tests first',
    'Going forward, keep PR bodies short',
    'I prefer tabs',
    "I'd rather you asked first",
    'you should have used the broker',
    "you shouldn't push to main",
    "that's wrong",
    'That is not right, the port is 8080',
    'not what I asked for',
    'Saved: /Users/x/Downloads/triage.decisions.json',
    'apply decisions',
    'Please apply the decisions from the board',
    'Please don\'t touch the lockfile',
    'actually, I prefer squash merges',
    'no, call it from the parser instead',
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

// Review F1 (0.21.1 audit): ordinary task requests, plain answers and pasted
// text must not read as corrections. Each of these fired before the fix.
describe('hasLearnSignal — ordinary requests and pasted text stay quiet (F1)', () => {
  const ordinary = [
    'Add a /health endpoint. It should return 200 with the version.',
    'It should return 200',
    'Rename the helper and call it from the parser instead of inlining it.',
    'call it from the parser instead',
    'Always run the tests before you push this branch.',
    'Stop hook output looks odd in the logs, can you look',
    'Stop the dev server',
    'Please review this; we should ship today.',
    'we should ship today',
    'Explain why we should cache responses',
    'no',
    'No.',
    'No — go ahead.',
    'no, not yet',
    'No, that is all',
    'What is review.decisions.json?',
    "Actually, let's also bump the version.",
    'Error: you should not call this before init',
    'TypeError: you must pass a string instead of a number',
    '    at Object.<anonymous> (/x/y.js:3:9) — you should not see this',
    '2026-10-01T10:00:00Z ERROR worker: never retried, use backoff instead',
    '[warn] you should not use the legacy flag',
    'Here is the log:\n```\nerror: you should use --force instead\nnever do this\n```\ncan you check it',
    '> Never push to main\nWhere does this rule come from?',
    'Here is the diff:\n\n    // we should cache this\n    const x = 1;\n\nwhat does it do?',
  ]
  for (const text of ordinary) {
    it(`no signal: ${JSON.stringify(text)}`, () => {
      expect(hasLearnSignal(text)).toBe(false)
    })
  }
})

// Review F2: typographic apostrophes, Slovenian and German core forms, and the
// keyword-free English correction shapes.
describe('hasLearnSignal — misses the old list had (F2)', () => {
  const missed = [
    // typographic apostrophes (macOS smart quotes, phones, pasted text)
    'Don’t use npm.',
    'I’d prefer tabs.',
    'That’s wrong.',
    'Don’t use npm, ok?',
    // English shapes with no keyword
    'Use pnpm, not npm.',
    'use pnpm not npm',
    'Wrong file — the config lives in packages/core.',
    'wrong port, it is 8080',
    "That's not how we do releases here; tags come from CI.",
    'Remember that the staging host is the second one.',
    // Slovenian
    'Ne, to je narobe. Uporabi pnpm.',
    'ne, uporabi pnpm',
    'To je narobe.',
    'Od zdaj naprej vedno uporabi pnpm.',
    'Nikoli ne pushaj na main.',
    'Vedno zaženi teste pred commitom.',
    'Raje uporabi yaml.',
    // German
    'Nein, das ist falsch.',
    'nein, nimm pnpm',
    'Das ist falsch.',
    'Ab jetzt immer pnpm verwenden.',
    'Nie auf main pushen.',
    'Immer zuerst die Tests laufen lassen.',
    'Lieber nimm yaml statt json.',
  ]
  for (const text of missed) {
    it(`signals: ${JSON.stringify(text)}`, () => {
      expect(hasLearnSignal(text)).toBe(true)
    })
  }
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
    expect(lastUserMessage(path)).toEqual({ id: 'want', text: 'no, use the other file', learned: false })
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

  // Review F3: only the message the human typed counts. Field shapes checked
  // against real Claude Code transcripts (2026-10-02): typed prompts carry
  // origin.kind "human" / promptSource "typed"; compaction summaries carry
  // isCompactSummary; tool results carry toolUseResult; command and shell
  // echoes are plain user lines whose text starts with a <tag>.
  it('stops at a compaction summary: it is not the user speaking, and what came before it is history', () => {
    const path = transcript([
      human('never push to main', { uuid: 'before-compaction' }),
      human('This session is being continued from a previous conversation that ran out of context. We should use pnpm instead.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      assistant('continuing'),
    ])
    expect(lastUserMessage(path)).toBeNull()
  })

  it('stops at a compaction summary from an older build without the flag (known prefix)', () => {
    const path = transcript([
      human('never push to main', { uuid: 'before-compaction' }),
      human('This session is being continued from a previous conversation that ran out of context. Always use pnpm instead.'),
    ])
    expect(lastUserMessage(path)).toBeNull()
  })

  it('stops at a compact_boundary system line', () => {
    const path = transcript([
      human('never push to main', { uuid: 'before-compaction' }),
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' },
    ])
    expect(lastUserMessage(path)).toBeNull()
  })

  it('skips local-command output, slash-command echoes, shell echoes and origin-less task notifications', () => {
    const path = transcript([
      human('always use pnpm', { uuid: 'typed', origin: { kind: 'human' }, promptSource: 'typed' }),
      human('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
      human('<local-command-stdout>you should not see this instead</local-command-stdout>'),
      human('<bash-input>git push</bash-input>'),
      human('<bash-stdout>never mind instead</bash-stdout><bash-stderr></bash-stderr>'),
      human('<task-notification>\n<status>completed</status>\nyou should use X instead</task-notification>'),
      human('<system-reminder>do not do this</system-reminder>'),
    ])
    expect(lastUserMessage(path)?.id).toBe('typed')
  })

  it('skips lines that are system-sourced or carry a tool result, even with text blocks beside it', () => {
    const path = transcript([
      human('from now on keep PRs small', { uuid: 'typed' }),
      human('a system prompt', { promptSource: 'system' }),
      human('tool output', { toolUseResult: { stdout: 'x' } }),
      human([{ type: 'tool_result', tool_use_id: 't', content: 'out' }, { type: 'text', text: 'never do X instead' }]),
    ])
    expect(lastUserMessage(path)?.id).toBe('typed')
  })

  // Review F4: the agent already saved it in that reply.
  it('reports whether plur_learn was called after the user message', () => {
    const learnCall = (name: string, input: Record<string, unknown> = {}) =>
      ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } })
    const saved = transcript([
      human('from now on use pnpm', { uuid: 'm1' }),
      learnCall('mcp__plur__plur_learn', { statement: 'use pnpm' }),
      toolResult(),
      assistant('saved'),
    ])
    expect(lastUserMessage(saved)).toMatchObject({ id: 'm1', learned: true })
    rmSync(dir, { recursive: true, force: true })

    const viaAdmin = transcript([human('from now on use pnpm', { uuid: 'm2' }), learnCall('mcp__plur__plur_admin', { action: 'plur_learn_batch' })])
    expect(lastUserMessage(viaAdmin)).toMatchObject({ id: 'm2', learned: true })
    rmSync(dir, { recursive: true, force: true })

    // A learn call BEFORE the message belongs to an earlier reply.
    const earlier = transcript([
      learnCall('mcp__plur__plur_learn'),
      human('from now on use pnpm', { uuid: 'm3' }),
      learnCall('mcp__plur__plur_recall'),
      assistant('done'),
    ])
    expect(lastUserMessage(earlier)).toMatchObject({ id: 'm3', learned: false })
  })

  // Re-audit R4: every text block is checked, not only the start of the joined text.
  it('drops system-reminder and notification echoes inside a typed message', () => {
    const path = transcript([
      human([{ type: 'text', text: 'Add tests.' }, { type: 'text', text: '<system-reminder>\nNever push to main.\n</system-reminder>' }], { uuid: 'mixed' }),
    ])
    const m = lastUserMessage(path)
    expect(m?.id).toBe('mixed')
    expect(m?.text).not.toContain('Never push')
    rmSync(dir, { recursive: true, force: true })
    const inline = transcript([human('Add tests.\n<system-reminder>\nAlways use pnpm.\n</system-reminder>', { uuid: 'inline' })])
    expect(lastUserMessage(inline)?.text).not.toContain('Always use pnpm')
  })

  it('an image-only turn is the latest message, not the correction before it', () => {
    const path = transcript([
      human('never push to main', { uuid: 'old' }),
      assistant('ok'),
      human([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], { uuid: 'img' }),
    ])
    expect(lastUserMessage(path)).toMatchObject({ id: 'img', text: '' })
  })

  it('an interrupt marker is the latest message, not the correction before it', () => {
    const path = transcript([
      human('never push to main', { uuid: 'old' }),
      assistant('working'),
      human([{ type: 'text', text: '[Request interrupted by user]' }], { uuid: 'intr' }),
    ])
    expect(lastUserMessage(path)?.id).toBe('intr')
  })

  it('a plur_learn call in a sidechain does not count as learned in this reply', () => {
    const path = transcript([
      human('from now on use pnpm', { uuid: 'm' }),
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'mcp__plur__plur_learn', input: {} }] } },
    ])
    expect(lastUserMessage(path)).toMatchObject({ id: 'm', learned: false })
  })

  // H4: a failed or unrelated tool call is not "learned".
  it('a plur_learn call that returned an error, or a look-alike tool name, does not count as learned', () => {
    const call = (id: string, name: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
    const result = (id: string, isError: boolean) => ({ type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'failed' : 'ok' }] } })
    const failed = transcript([human('from now on use pnpm', { uuid: 'f' }), call('a', 'mcp__plur__plur_learn'), result('a', true)])
    expect(lastUserMessage(failed)).toMatchObject({ id: 'f', learned: false })
    rmSync(dir, { recursive: true, force: true })
    const lookalike = transcript([human('from now on use pnpm', { uuid: 'l' }), call('b', 'mcp__x__plur_learning_stats'), result('b', false)])
    expect(lastUserMessage(lookalike)).toMatchObject({ id: 'l', learned: false })
    rmSync(dir, { recursive: true, force: true })
    const ok = transcript([human('from now on use pnpm', { uuid: 'o' }), call('c', 'mcp__plur__plur_learn'), result('c', false)])
    expect(lastUserMessage(ok)).toMatchObject({ id: 'o', learned: true })
  })

  it('a message typed with a literal <system-reminder> is still the latest message, with its text (H5)', () => {
    const path = transcript([human('never push to main', { uuid: 'old' }), assistant('ok'), human('<system-reminder> what is this tag? From now on use pnpm.', { uuid: 'new' })])
    const m = lastUserMessage(path)
    expect(m?.id).toBe('new')
    expect(m?.text).toContain('From now on')
  })

  it('reads only a bounded tail of a large transcript', () => {
    // The old message sits before the tail window; only filler follows within it.
    const filler = assistant('x'.repeat(1024))
    const n = Math.ceil(TRANSCRIPT_TAIL_BYTES / 1024) + 10
    const path = transcript([human('from now on use tabs', { uuid: 'far' }), ...Array.from({ length: n }, () => filler)])
    expect(lastUserMessage(path)).toBeNull()
  })
})

// Review F6: the "already nudged for this message" marker is claimed with an
// exclusive, no-follow create, so two racing Stops cannot both nudge, a
// planted symlink is never written through, and an unwritable marker means
// "do not nudge" rather than "nudge every time".
describe('claimNudge', () => {
  let dir: string
  afterEach(() => { if (dir) { try { chmodSync(dir, 0o700) } catch {} rmSync(dir, { recursive: true, force: true }) } })

  it('claims once: the second claim for the same marker loses', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claim-'))
    const m = join(dir, 'k.learn-abc.nudged')
    expect(claimNudge(m)).toBe(true)
    expect(claimNudge(m)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('never writes through a planted symlink, and does not nudge', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claim-'))
    const target = join(dir, 'target')
    writeFileSync(target, 'precious')
    const m = join(dir, 'k.learn-abc.nudged')
    symlinkSync(target, m)
    expect(claimNudge(m)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  it.skipIf(process.platform === 'win32')('an unwritable marker location is "do not nudge", every time', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claim-'))
    chmodSync(dir, 0o500)
    const m = join(dir, 'k.learn-abc.nudged')
    expect(claimNudge(m)).toBe(false)
    expect(claimNudge(m)).toBe(false)
  })
})

// Fallback default: every 10th Stop (see learnFallbackInterval).
// Re-audit R2: pasted text is removed BEFORE the length bound, and the bound
// keeps the tail, where the typed text usually is.
// Re-audit round 3 (H2, H3, H5 and the requested generalisations).
describe('hasLearnSignal — round 3', () => {
  const signals = [
    // H2: a task-scope word exempts only its own sentence
    'Never push to main. Fix the failing test here.',
    'Always use pnpm. Also, the build is broken today, can you look?',
    'Fix this PR. Always use pnpm.',
    // diacritic-insensitive
    'To je napacno.',
    'narobe si razumel, gre za macos',
    // Slovenian negative commands anywhere, nikar, ne smeš
    'Prosim, ne briši vej.',
    'tega ne delaj brez vprašanja',
    'Nikar ne pushaj na main.',
    'Tega ne smeš commitat.',
    // rule words inside an imperative sentence
    'Teste vedno poženi pred commitom.',
    'Füge niemals Secrets in Logs ein.',
    'Keine Emojis, bitte.',
    "Don't ever log the token.",
    // conventions, corrections, decisions
    'Pri nas uporabljamo pnpm.',
    'Bei uns gilt: erst Test, dann Code.',
    'Nisi pravilno popravil.',
    'Mislim, da si se zmotil.',
    'Falsch verstanden, es geht um Linux.',
    'Nope, it lives in core.',
    'Remember: the helper owns dates.',
    'We decided to drop Node 18.',
    'Odločili smo, da gremo s SQLite.',
    'Q1: yes. Q2: keep both.',
  ]
  for (const text of signals) it(`signals: ${JSON.stringify(text)}`, () => expect(hasLearnSignal(text)).toBe(true))

  const plain = [
    // H3
    'Narobe si je zapomnil geslo, ponastavi ga.',
    'Napačen vrstni red elementov po sortiranju, popravi sort.',
    'Spet si mi poslal isti link, a je to prav?',
    'A to ni prav, prav?',
    'Is it true that we always use npm, ok?',
    // H5: a literal tag typed in prose does not hide what follows; still no signal here
    'What does the <system-reminder> tag do in a transcript?',
  ]
  for (const text of plain) it(`no signal: ${JSON.stringify(text)}`, () => expect(hasLearnSignal(text)).toBe(false))

  it('a literal, unclosed <system-reminder> typed by the user does not swallow the rest (H5)', () => {
    expect(hasLearnSignal('Why does `<system-reminder>` show up in logs? From now on use pnpm.')).toBe(true)
    expect(normaliseForSignal('see <system-reminder> here. From now on use pnpm.')).toContain('From now on')
  })
})

describe('normaliseForSignal', () => {
  it('keeps a correction typed after a long pasted log', () => {
    const log = Array.from({ length: 200 }, (_, i) => `2026-10-01 12:00:${String(i % 60).padStart(2, '0')} INFO request served ok`).join('\n')
    expect(normaliseForSignal(`${log}\n\nThat's wrong, revert it.`)).toContain("That's wrong")
  })
  it('keeps the tail of long prose', () => {
    expect(normaliseForSignal('x '.repeat(5000) + 'From now on use pnpm.')).toContain('From now on use pnpm.')
  })
  it('keeps Markdown headings and sentences that start with "At"', () => {
    expect(normaliseForSignal('# From now on, use pnpm.')).toContain('From now on')
    expect(normaliseForSignal('At work, from now on use pnpm.')).toContain('from now on')
    expect(normaliseForSignal('    at foo (src/x.ts:3:9)')).not.toContain('foo')
  })
})

describe('learnFallbackInterval', () => {
  it('defaults to 10', () => expect(learnFallbackInterval({})).toBe(10))
  it('reads PLUR_LEARN_FALLBACK_INTERVAL', () => expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: '5' })).toBe(5))
  it('0 disables the fallback', () => expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: '0' })).toBe(0))
  it('garbage falls back to the default', () => {
    expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: 'abc' })).toBe(10)
    expect(learnFallbackInterval({ PLUR_LEARN_FALLBACK_INTERVAL: '-3' })).toBe(10)
  })
})
