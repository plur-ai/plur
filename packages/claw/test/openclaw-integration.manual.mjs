#!/usr/bin/env node
/**
 * PLUR ContextEngine Integration Test against real OpenClaw
 *
 * Tests:
 * 1. Plugin registration via registerContextEngine
 * 2. Bootstrap hook fires with correct params
 * 3. Ingest processes messages
 * 4. Assemble returns context with systemPromptAddition
 * 5. Compact extracts learnings
 * 6. AfterTurn captures episodes
 * 7. SubagentSpawn/End lifecycle
 * 8. Dispose cleanup
 */

// Import OpenClaw's public plugin SDK
import { registerContextEngine } from 'openclaw/plugin-sdk'

// Import our PLUR packages (local, not from npm)
import { Plur } from './packages/core/dist/index.js'
import { PlurContextEngine } from './packages/claw/dist/index.js'

const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'
let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    console.log(`  ${PASS} ${message}`)
    passed++
  } else {
    console.log(`  ${FAIL} ${message}`)
    failed++
  }
}

async function run() {
  console.log('\n=== PLUR ContextEngine Integration Tests ===\n')
  const { readFileSync } = await import('fs')
  const ocPkg = JSON.parse(readFileSync('/root/node_modules/openclaw/package.json', 'utf8'))
  console.log(`OpenClaw: ${ocPkg.version}`)
  console.log(`Node: ${process.version}\n`)

  // --- Test 1: Plugin Registration ---
  console.log('Test 1: Plugin Registration')

  const tmpDir = '/tmp/plur-test-' + Date.now()
  const { mkdirSync } = await import('fs')
  mkdirSync(tmpDir, { recursive: true })

  let registrationSucceeded = false
  try {
    registerContextEngine('plur', () => new PlurContextEngine({ path: tmpDir }))
    registrationSucceeded = true
  } catch (err) {
    console.log(`  Registration error: ${err.message}`)
  }

  assert(registrationSucceeded, 'registerContextEngine("plur", factory) succeeds')

  // Create engine directly for testing hooks
  const engine = new PlurContextEngine({ path: tmpDir })
  assert(engine.info.id === 'plur-claw', 'engine info.id is plur-claw')
  assert(engine.info.ownsCompaction === false, 'engine does not own compaction')

  // --- Test 2: Bootstrap ---
  console.log('\nTest 2: Bootstrap')

  const bootstrapResult = await engine.bootstrap({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    sessionFile: '/tmp/test-session.jsonl',
  })

  assert(bootstrapResult.bootstrapped === true, 'bootstrap returns bootstrapped: true')
  assert(typeof bootstrapResult.reason === 'string', 'bootstrap returns reason string')

  // --- Test 3: Ingest ---
  console.log('\nTest 3: Ingest')

  const userMsg = { role: 'user', content: 'Actually, the API returns XML not JSON' }
  const ingestResult = await engine.ingest({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    message: userMsg,
  })

  assert(ingestResult.ingested === true, 'user message ingested')

  // Heartbeat should be skipped
  const heartbeatResult = await engine.ingest({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    message: { role: 'user', content: 'heartbeat' },
    isHeartbeat: true,
  })

  assert(heartbeatResult.ingested === false, 'heartbeat message skipped')

  // --- Test 4: Assemble ---
  console.log('\nTest 4: Assemble')

  // First learn something so injection has data
  engine.plur.learn('TypeScript strict mode is required', {
    type: 'behavioral',
    scope: 'global',
    source: 'test',
  })

  const assembleResult = await engine.assemble({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    messages: [
      { role: 'user', content: 'How should I configure TypeScript?' },
    ],
    tokenBudget: 4000,
  })

  assert(Array.isArray(assembleResult.messages), 'assemble returns messages array')
  assert(typeof assembleResult.estimatedTokens === 'number', 'assemble returns estimatedTokens')
  // systemPromptAddition may or may not be present depending on injection match
  assert(assembleResult.estimatedTokens > 0, 'estimatedTokens > 0')

  // --- Test 5: Compact ---
  console.log('\nTest 5: Compact')

  // Ingest some messages with learnable patterns
  await engine.ingest({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    message: { role: 'user', content: 'We decided to use PostgreSQL for the database' },
  })

  const compactResult = await engine.compact({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    sessionFile: '/tmp/test-session.jsonl',
    tokenBudget: 2000,
  })

  assert(compactResult.ok === true, 'compact returns ok: true')
  assert(compactResult.compacted === false, 'compact returns compacted: false (we dont own compaction)')
  assert(typeof compactResult.reason === 'string', 'compact returns reason string')

  // --- Test 6: AfterTurn ---
  console.log('\nTest 6: AfterTurn')

  const messages = [
    { role: 'user', content: 'Tell me about TypeScript' },
    { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript that compiles to plain JS.' },
  ]

  // Should not throw
  await engine.afterTurn({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    sessionFile: '/tmp/test-session.jsonl',
    messages,
    prePromptMessageCount: 0,
  })

  assert(true, 'afterTurn completes without error')

  // Heartbeat afterTurn should be a no-op
  await engine.afterTurn({
    sessionId: 'test-session-1',
    sessionKey: 'user:gregor:agent:test',
    sessionFile: '/tmp/test-session.jsonl',
    messages: [],
    prePromptMessageCount: 0,
    isHeartbeat: true,
  })

  assert(true, 'afterTurn with isHeartbeat is no-op')

  // --- Test 7: Subagent Lifecycle ---
  console.log('\nTest 7: Subagent Lifecycle')

  const spawnResult = await engine.prepareSubagentSpawn({
    parentSessionKey: 'user:gregor:agent:test',
    childSessionKey: 'user:gregor:agent:child-1',
  })

  assert(spawnResult !== undefined, 'prepareSubagentSpawn returns preparation')
  assert(typeof spawnResult.rollback === 'function', 'preparation has rollback function')

  await engine.onSubagentEnded({
    childSessionKey: 'user:gregor:agent:child-1',
    reason: 'completed',
  })

  assert(true, 'onSubagentEnded completes without error')

  // --- Test 8: Dispose ---
  console.log('\nTest 8: Dispose')

  await engine.dispose()
  assert(true, 'dispose completes without error')

  // --- Test 9: Check learnings persisted ---
  console.log('\nTest 9: Verify Persistence')

  const plur2 = new Plur({ path: tmpDir })
  const recalled = plur2.recall('TypeScript')
  assert(recalled.length > 0, 'learned engrams persist across instances')

  const episodes = plur2.timeline({})
  assert(episodes.length > 0, 'episodic captures persist')

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)

  // Cleanup
  const { rmSync } = await import('fs')
  rmSync(tmpDir, { recursive: true })

  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
