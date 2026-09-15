#!/usr/bin/env node
// Manual acceptance gate for @plur-ai/opencode — requires a real opencode
// binary, real provider auth, and network access. NOT part of `pnpm test`.
//
// Run: node packages/opencode/test/e2e.manual.mjs
// Override model: PLUR_E2E_MODEL=openai/gpt-5.5 node packages/opencode/test/e2e.manual.mjs
//
// Unit tests prove the hooks return the right objects. They cannot prove
// context reached the model — the documented failure mode for PLUR plugin
// releases is a plugin that loads, registers, reports healthy, and injects
// nothing. This script builds the REAL publishable artifact (packed
// tarballs, not a dist/ directory copy — tsup does not bundle
// @plur-ai/core, so a bare directory copy cannot resolve it), installs it
// like a real user would, and drives a real opencode session against it.
//
// Three assertions:
//   1. Recall reaches the model (fresh session, seeded fact, ask for it back).
//   2. The injection path is live (a read-only observer plugin reports the
//      PLUR header present in the rendered system[] array).
//   3. No transcript accretion (the observer's message-history block count
//      is 0 on every turn of a 3-turn continued session).
//
// Exactly 4 opencode invocations = 4 model calls total.

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, rmSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const MODEL = process.env.PLUR_E2E_MODEL || 'openai/gpt-5.5'
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PLUR_MEMORY_MARKER = 'PLUR Memory System'

class GateFailure extends Error {}
function fail(label, detail) { throw new GateFailure(`FAIL [${label}]: ${detail}`) }
function step(msg) { console.log(`\n=== ${msg} ===`) }

/** Run a command with stdio inherited (build output streams live). */
function runInherit(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', ...opts })
}

/** Run a command and capture output, failing the gate with context on error. */
function runCapture(label, cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', ...opts })
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n')
    fail(label, `${cmd} ${args.join(' ')} failed: ${err.message}\n${out}`)
  }
}

/** Pack one workspace package into its own empty destination dir; return the tarball path. */
function packOne(pkgName, destDir) {
  mkdirSync(destDir, { recursive: true })
  runCapture(`pack:${pkgName}`, 'pnpm', ['--filter', pkgName, 'pack', '--pack-destination', destDir], { cwd: REPO_ROOT })
  const tgz = readdirSync(destDir).filter((f) => f.endsWith('.tgz'))
  if (tgz.length !== 1) fail(`pack:${pkgName}`, `expected exactly one .tgz in ${destDir}, found: ${tgz.join(', ') || '(none)'}`)
  return join(destDir, tgz[0])
}

async function main() {
  step('Checking prerequisites')
  const realAuthPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  if (!existsSync(realAuthPath)) {
    fail('setup', `No opencode auth found at ${realAuthPath} — run \`opencode auth login\` first.`)
  }
  console.log(`Using model: ${MODEL}`)
  console.log(`Repo root: ${REPO_ROOT}`)

  const root = mkdtempSync(join(tmpdir(), 'plur-oc-e2e-'))
  console.log(`Temp root: ${root}`)

  try {
    const harness = join(root, 'harness')
    const work = join(harness, 'work')
    const pluginsDir = join(harness, 'plugins')
    const xdgConfig = join(root, 'xdg-config')
    const xdgData = join(root, 'xdg-data')
    const xdgCache = join(root, 'xdg-cache')
    const xdgState = join(root, 'xdg-state')
    const plurStore = join(root, 'plur-store')
    const observerLog = join(root, 'observer.log')
    for (const d of [harness, work, pluginsDir, xdgConfig, xdgData, xdgCache, xdgState, plurStore]) {
      mkdirSync(d, { recursive: true })
    }

    // Isolate auth: copy (never move/link) the real credential into the
    // isolated XDG data dir so opencode authenticates without ever writing
    // to (or reading from) the user's real ~/.local/share/opencode.
    mkdirSync(join(xdgData, 'opencode'), { recursive: true })
    copyFileSync(realAuthPath, join(xdgData, 'opencode', 'auth.json'))

    step('Step 1: Build core, opencode, and cli')
    runInherit('pnpm', ['--filter', '@plur-ai/core', 'build'])
    runInherit('pnpm', ['--filter', '@plur-ai/opencode', 'build'])
    runInherit('pnpm', ['--filter', '@plur-ai/cli', 'build'])

    step('Step 2: Pack both packages')
    const packDir = join(root, 'pack')
    const coreTarball = packOne('@plur-ai/core', join(packDir, 'core'))
    const opencodeTarball = packOne('@plur-ai/opencode', join(packDir, 'opencode'))
    console.log(`core tarball: ${coreTarball}`)
    console.log(`opencode tarball: ${opencodeTarball}`)

    step('Step 3: Assert workspace:* was rewritten to a concrete version')
    const pkgJsonRaw = runCapture(
      'publish-safety',
      'tar', ['-xOzf', opencodeTarball, 'package/package.json'],
      {},
    )
    const packedPkg = JSON.parse(pkgJsonRaw)
    const coreDepVersion = packedPkg.dependencies && packedPkg.dependencies['@plur-ai/core']
    console.log(`packed @plur-ai/opencode package.json dependencies["@plur-ai/core"] = ${JSON.stringify(coreDepVersion)}`)
    if (!coreDepVersion || !/^\d/.test(coreDepVersion)) {
      fail(
        'publish-safety',
        `packed @plur-ai/opencode declares @plur-ai/core as ${JSON.stringify(coreDepVersion)} — ` +
        `"workspace:*" was NOT rewritten to a concrete version. This tarball cannot resolve its own ` +
        `dependency if published as-is.`,
      )
    }
    console.log(`PASS: workspace:* rewritten to concrete version ${coreDepVersion}`)

    step('Step 4: Create harness dir, write package.json, install tarballs')
    writeFileSync(
      join(harness, 'package.json'),
      JSON.stringify({
        name: 'plur-e2e-harness',
        private: true,
        version: '0.0.0',
        dependencies: {
          '@plur-ai/core': `file:${coreTarball}`,
          '@plur-ai/opencode': `file:${opencodeTarball}`,
        },
      }, null, 2),
    )
    console.log('Installer: npm install (verified to resolve file: tarball deps cleanly against this pnpm-workspace repo)')
    runInherit('npm', ['install', '--no-audit', '--no-fund'], { cwd: harness })

    step('Step 5: Write opencode.json')
    writeFileSync(
      join(harness, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        // Real plugin first, observer second — the observer's hooks run
        // after the real plugin's for the same event, so it sees what the
        // real plugin already pushed into system[]/messages[].
        // Load the plugin from the INSTALLED packed tarball by path, not by
        // bare package name. opencode resolves a bare name by having Bun fetch
        // it from the npm registry at startup; @plur-ai/opencode is not
        // published yet, so that silently resolves to nothing — no error in
        // opencode's log, just a plugin that never loads. Verified against
        // 1.18.30: with plugin: ['@plur-ai/opencode', ...] the observer fired
        // but reported SYSTEM present=false, and the model confabulated an
        // answer instead of recalling one. Loading the installed dist by path
        // exercises the same packed artifact (its own `import "@plur-ai/core"`
        // resolves from this harness's node_modules). What `plur init
        // --opencode` writes for real users — the bare name — starts working
        // the moment the package is on npm, and cannot be exercised before then.
        plugin: ['./node_modules/@plur-ai/opencode/dist/index.js', './plugins/observer.mjs'],
        share: 'disabled',
        autoupdate: false,
        // This gate measures whether MEMORY reaches the model, not whether
        // the model can find the answer by exploring the filesystem. The
        // default "build" agent has bash/read/grep/edit tools and a
        // fact-lookup question otherwise sends it exploring instead of
        // answering from context — observed empirically. Deny every
        // tool so the only possible source of the answer is context.
        tools: {
          bash: false, read: false, grep: false, glob: false, list: false,
          edit: false, write: false, patch: false, webfetch: false, websearch: false,
          task: false, skill: false, todowrite: false, agent: false,
        },
      }, null, 2),
    )

    step('Step 6: Write the read-only observer plugin')
    writeFileSync(
      join(pluginsDir, 'observer.mjs'),
      `// PLUR e2e observer — read-only test instrument. Never injects, never
// mutates. Logs two signals to PLUR_E2E_OBSERVER_LOG:
//   SYSTEM   present=<bool> — whether the PLUR header is present in output.system
//   MESSAGES count=<n>      — how many text parts in output.messages carry the header
import { appendFileSync } from 'node:fs'

const LOG = process.env.PLUR_E2E_OBSERVER_LOG
const MARKER = ${JSON.stringify(PLUR_MEMORY_MARKER)}

function log(line) {
  if (!LOG) return
  try { appendFileSync(LOG, \`[\${new Date().toISOString()}] \${line}\\n\`) } catch { /* best-effort */ }
}

export const PlurE2EObserver = async () => ({
  'experimental.chat.system.transform': async (input, output) => {
    const present = (output.system || []).some(
      (s) => typeof s === 'string' && s.includes(MARKER),
    )
    log(\`SYSTEM session=\${input?.sessionID ?? 'unknown'} present=\${present}\`)
  },

  'experimental.chat.messages.transform': async (input, output) => {
    let count = 0
    for (const m of output.messages || []) {
      for (const p of m.parts || []) {
        if (p?.type === 'text' && typeof p.text === 'string' && p.text.includes(MARKER)) count++
      }
    }
    log(\`MESSAGES session=\${input?.sessionID ?? 'unknown'} count=\${count}\`)
  },
})

export default PlurE2EObserver
`,
    )

    step('Step 7: Seed one distinctive fact via the LOCAL built CLI')
    const token = randomBytes(3).toString('hex')
    const projectName = `Nightjar-${token}`
    const hostFact = `host-${token}.plur-e2e.internal`
    const factStatement = `The canary deploy host for project ${projectName} is ${hostFact}.`
    const recallQuestion = `What is the canary deploy host for project ${projectName}? Answer with only the hostname and nothing else.`
    const cliEntry = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js')
    if (!existsSync(cliEntry)) fail('setup', `CLI dist not found after build: ${cliEntry}`)
    const learnOut = runCapture(
      'seed',
      'node', [cliEntry, 'learn', factStatement],
      { cwd: REPO_ROOT, env: { ...process.env, PLUR_PATH: plurStore,
        ...(process.env.PLUR_E2E_FULL ? {} : { PLUR_DISABLE_EMBEDDINGS: '1' }) } },
    )
    console.log(learnOut.trim())

    // Common environment for every opencode invocation below. Every one of
    // the three directories the task must never touch is overridden:
    // XDG_CONFIG_HOME takes ~/.config/opencode out of the loop entirely,
    // XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME take ~/.local/share and
    // ~/.local/state out of the loop, and PLUR_PATH takes ~/.plur out of
    // the loop. OPENCODE_CONFIG_DIR/OPENCODE_CONFIG point at our harness.
    // A minimal env allowlist, NOT `...process.env`. opencode's default
    // agent has a bash tool, and this gate observed it run `env` while
    // exploring — a blanket env spread would hand every ambient secret in
    // the calling shell (API keys, session tokens) to a model tool call.
    // Only what opencode/npm-installed-binaries need to run is forwarded.
    const SAFE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME']
    const baseEnv = {}
    for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) baseEnv[k] = process.env[k]
    const ocEnv = {
      ...baseEnv,
      // Node's child_process `cwd` only chdir()s the child — it does NOT
      // update an inherited PWD, and opencode prefers PWD (symlink-safe
      // logical cwd) over the physical cwd when present. Left unset here,
      // opencode resolved "directory" to the caller's real worktree instead
      // of the isolated `work` dir and the model found the seeded fact by
      // grepping the real repo instead of via injected memory — a false
      // pass. Overriding PWD (plus --dir below, belt-and-suspenders) closes
      // that hole.
      PWD: work,
      OPENCODE_CONFIG_DIR: harness,
      OPENCODE_CONFIG: join(harness, 'opencode.json'),
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      PLUR_PATH: plurStore,
      PLUR_E2E_OBSERVER_LOG: observerLog,
      // Local embeddings (transformers + onnxruntime) load INSIDE the opencode
      // process when the plugin constructs Plur. On a loaded machine that was
      // enough to get this gate OOM-killed mid-turn. None of the three
      // assertions depend on embedding quality — one seeded engram with
      // distinctive tokens is found by BM25 alone — so the gate runs
      // BM25-only by default and stays reliable. Set PLUR_E2E_FULL=1 to
      // exercise the hybrid path when you have the headroom.
      ...(process.env.PLUR_E2E_FULL ? {} : { PLUR_DISABLE_EMBEDDINGS: '1' }),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    }

    function runOpencode(label, args) {
      writeFileSync(observerLog, '') // isolate this turn's observer signal
      try {
        return execFileSync(
          'opencode',
          ['run', '--dir', work, '--model', MODEL, ...args],
          { cwd: work, env: ocEnv, encoding: 'utf8', timeout: 120000 },
        )
      } catch (err) {
        const out = [err.stdout, err.stderr].filter(Boolean).join('\n')
        fail(label, `opencode run ${args.join(' ')} failed: ${err.message}\n${out}`)
      }
    }
    function readObserverLog() {
      return existsSync(observerLog) ? readFileSync(observerLog, 'utf8') : ''
    }

    step('Assertion 1+2: fresh session recall, and injection-path liveness')
    const recallOut = runOpencode('assertion-1-recall', ['--title', 'recall', recallQuestion])
    console.log(`Model answer:\n${recallOut.trim()}`)
    if (!recallOut.includes(hostFact)) {
      fail(
        'assertion-1-recall',
        `fresh-session answer did not contain the seeded fact "${hostFact}". Full output:\n${recallOut}`,
      )
    }
    console.log(`PASS assertion 1: recall reached the model ("${hostFact}" found in the answer)`)

    const obsLogRecall = readObserverLog()
    const systemLines = obsLogRecall.split('\n').filter((l) => l.includes('SYSTEM '))
    if (systemLines.length === 0) {
      fail(
        'assertion-2-injection-live',
        `observer's experimental.chat.system.transform never fired during the recall turn — ` +
        `the harness contract may have moved. Observer log:\n${obsLogRecall}`,
      )
    }
    if (!systemLines.some((l) => l.includes('present=true'))) {
      fail(
        'assertion-2-injection-live',
        `observer did not report the PLUR header present in system[] during the recall turn.\n${systemLines.join('\n')}`,
      )
    }
    console.log(`PASS assertion 2: injection path is live — ${systemLines.join(' | ')}`)

    step('Assertion 3: three-turn continued session, transcript accretion must be 0 every turn')
    const turns = [
      ['--title', 'accrete', 'Say 1'],
      ['-c', 'Say 2'],
      ['-c', 'Say 3'],
    ]
    for (let i = 0; i < turns.length; i++) {
      const out = runOpencode('assertion-3-accretion', turns[i])
      console.log(`turn ${i + 1} model output: ${out.trim()}`)
      const obsLog = readObserverLog()
      const msgLines = obsLog.split('\n').filter((l) => l.includes('MESSAGES '))
      if (msgLines.length === 0) {
        fail(
          'assertion-3-accretion',
          `observer's experimental.chat.messages.transform never fired on turn ${i + 1} — ` +
          `the harness contract may have moved. Observer log:\n${obsLog}`,
        )
      }
      const counts = msgLines.map((l) => {
        const m = l.match(/count=(\d+)/)
        return m ? Number(m[1]) : NaN
      })
      const bad = counts.some((c) => Number.isNaN(c) || c !== 0)
      if (bad) {
        fail(
          'assertion-3-accretion',
          `turn ${i + 1} counted non-zero "PLUR Memory System" blocks in message history ` +
          `(expected 0 on every turn): counts=[${counts.join(', ')}]. This is exactly the ` +
          `accretion the system.transform design exists to prevent — injecting via chat.message ` +
          `instead would give 1, then 2, then 3.\n${msgLines.join('\n')}`,
        )
      }
      console.log(`turn ${i + 1}/3 accretion count(s): [${counts.join(', ')}] — OK`)
    }
    console.log('PASS assertion 3: transcript accretion is 0 on every turn')

    console.log(
      `\nPASS: recall reached the model, injection path is live, transcript accretion is 0 across 3 turns ` +
      `(model=${MODEL}, 4 opencode invocations total)`,
    )
  } catch (err) {
    if (err instanceof GateFailure) {
      console.error(`\n${err.message}`)
    } else {
      console.error(`\nFAIL [unexpected]: ${err.stack || err}`)
    }
    process.exitCode = 1
  } finally {
    step('Cleanup')
    if (process.env.PLUR_E2E_KEEP_TMP) {
      console.log(`PLUR_E2E_KEEP_TMP set — leaving ${root} in place for inspection`)
    } else {
      try {
        rmSync(root, { recursive: true, force: true })
        console.log(`Removed ${root}`)
      } catch (cleanupErr) {
        console.error(`Warning: failed to clean up ${root}: ${cleanupErr.message}`)
      }
    }
  }
}

main()
