/**
 * #1347 (hook integration): the folder map must not change what the hooks
 * print in a folder that is configured today.
 *
 * Two fixtures, each run through the main hooks of all four editors:
 *   - `plur-yaml`: a repo with a TRUSTED `.plur.yaml` (scope + domain);
 *   - `mcp-config`: a repo whose `.mcp.json` names the plur server, with no
 *     `.plur.yaml`.
 *
 * The golden files under `fixtures/hook-golden/` were captured on the base of
 * the hook-integration PR (fix/1301-watchdog-lock merged with the folder-map
 * core), BEFORE any hook read the folder map, by running this suite with
 * `PLUR_UPDATE_GOLDEN=1`. The suite replays the fixtures and compares every
 * hook's stdout (and the Cursor rule file) byte for byte, after replacing the
 * temp directory with `<DIR>`, dates and session ids.
 *
 * HOME, USERPROFILE, TMPDIR and PLUR_PATH are set inside each spawn, so the
 * real ~/.plur is never touched. Hybrid search is off so the answers are
 * deterministic BM25.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const GOLDEN_DIR = join(__dirname, 'fixtures', 'hook-golden')
const UPDATE = process.env.PLUR_UPDATE_GOLDEN === '1'

type Kind = 'plur-yaml' | 'mcp-config'

describe('hook output in configured folders is unchanged by the folder map (#1347)', () => {
  let dir: string
  let repo: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-hook-golden-')))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
      PLUR_HOOK_HYBRID: 'off',
    }
    delete env.CLAUDE_SESSION_ID
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function cli(args: string[], input?: string): string {
    const r = runCli('node', [CLI, ...args], {
      encoding: 'utf-8', env, cwd: repo, ...(input !== undefined ? { input } : {}),
    })
    return r.stdout ?? ''
  }

  function normalise(out: string): string {
    return out
      .split(dir).join('<DIR>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>')
      .replace(/ENG-\d{4}-\d{2}-\d{2}-/g, 'ENG-<DATE>-')
      .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
  }

  function check(name: string, actual: string): void {
    const file = join(GOLDEN_DIR, `${name}.txt`)
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true })
      writeFileSync(file, actual)
      return
    }
    expect(existsSync(file), `golden ${file} missing`).toBe(true)
    expect(actual).toBe(readFileSync(file, 'utf8'))
  }

  function setup(kind: Kind): void {
    mkdirSync(join(dir, '.plur'), { recursive: true })
    if (kind === 'plur-yaml') {
      writeFileSync(join(repo, '.plur.yaml'), 'scope: project:fixture\ndomain: fixture.deploy\n')
      writeFileSync(join(dir, '.plur', 'trust.yaml'), `version: 1\ntrusted:\n  - ${repo}\n`)
    } else {
      writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur' } } }))
    }
    cli(['learn', 'Fixture deploys go through the blue staging lane before release',
      '--scope', 'project:fixture', '--domain', 'fixture.deploy', '--json'])
    cli(['learn', 'Fixture deploys are announced in the release channel first', '--json'])
  }

  function transcript(text: string): string {
    const p = join(dir, 'agy-transcript.jsonl')
    writeFileSync(p, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }) + '\n')
    return p
  }

  function runAll(): string {
    const sections: string[] = []
    const add = (name: string, out: string) => sections.push(`== ${name} ==\n${normalise(out)}`)
    const cc = { session_id: 'golden-cc', cwd: repo }

    // Claude Code
    add('hook-session-remind', cli(['hook-session-remind'], JSON.stringify({ ...cc, hook_event_name: 'SessionStart' })))
    add('hook-inject first prompt', cli(['hook-inject'], JSON.stringify({ ...cc, prompt: 'how do fixture deploys reach release' })))
    add('hook-inject later prompt', cli(['hook-inject'], JSON.stringify({ ...cc, prompt: 'No, from now on deploys go through the green lane' })))
    add('hook-session-guard', cli(['hook-session-guard'], JSON.stringify({ ...cc, tool_name: 'Bash' })))
    add('hook-observe', cli(['hook-observe'], JSON.stringify({ ...cc, tool_name: 'Bash', tool_input: { command: 'ls' } })))
    add('observations written', String(existsSync(join(dir, '.plur', 'observations'))))

    // Codex
    const cx = { session_id: 'golden-codex', cwd: repo }
    add('hook-codex-session-start', cli(['hook-codex-session-start'], JSON.stringify({ ...cx, hook_event_name: 'SessionStart', source: 'startup' })))
    add('hook-codex-inject', cli(['hook-codex-inject'], JSON.stringify({ ...cx, hook_event_name: 'UserPromptSubmit', prompt: 'how do fixture deploys reach release' })))
    add('hook-codex-guard', cli(['hook-codex-guard'], JSON.stringify({ session_id: 'golden-codex-2', cwd: repo, tool_name: 'shell' })))

    // Cursor
    add('hook-cursor-session-start', cli(['hook-cursor-session-start'], JSON.stringify({ conversation_id: 'golden-cursor' })))
    const rule = join(repo, '.cursor', 'rules', 'plur-context.mdc')
    add('cursor rule file', existsSync(rule) ? readFileSync(rule, 'utf8') : '(none)')
    add('hook-cursor-guard', cli(['hook-cursor-guard'], JSON.stringify({ conversation_id: 'golden-cursor-2', tool_name: 'Shell' })))

    // Antigravity
    const agy = { conversationId: 'golden-agy', invocationNum: 0, workspacePaths: [repo], transcriptPath: transcript('how do fixture deploys reach release') }
    add('hook-agy-pre-invocation', cli(['hook-agy-pre-invocation'], JSON.stringify(agy)))
    add('hook-agy-guard', cli(['hook-agy-guard'], JSON.stringify({ conversationId: 'golden-agy-2', workspacePaths: [repo], toolCall: { name: 'run_command' } })))

    return sections.join('\n') + '\n'
  }

  for (const kind of ['plur-yaml', 'mcp-config'] as const) {
    it(`${kind}: every editor's hooks print what the base printed`, () => {
      setup(kind)
      check(kind, runAll())
    }, 180_000)
  }
})
