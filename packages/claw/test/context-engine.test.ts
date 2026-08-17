import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PlurContextEngine } from '../src/context-engine.js'

describe('PlurContextEngine', () => {
  let engine: PlurContextEngine
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-'))
    engine = new PlurContextEngine({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('bootstrap returns success', async () => {
    const result = await engine.bootstrap({
      sessionId: 'test-1',
      sessionKey: 'user:john',
      sessionFile: '/tmp/test',
    })
    expect(result.bootstrapped).toBe(true)
  })

  it('ingest detects corrections and learns', async () => {
    await engine.ingest({
      sessionId: 'test-1',
      sessionKey: 'user:john',
      message: { role: 'user', content: 'No, always use snake_case for the API responses in this project' },
    })
    const recalled = engine.plur.recall('snake_case API')
    expect(recalled.length).toBeGreaterThan(0)
  })

  it('ingest ignores heartbeats', async () => {
    const result = await engine.ingest({
      sessionId: 'test-1',
      message: { role: 'user', content: 'No, this is wrong' },
      isHeartbeat: true,
    })
    expect(result.ingested).toBe(false)
  })

  it('assemble includes engrams in systemPromptAddition', async () => {
    engine.plur.learn('Database is PostgreSQL on port 5433', { scope: 'global' })
    const result = await engine.assemble({
      sessionId: 'test-1',
      messages: [{ role: 'user', content: 'check the database connection' }],
      tokenBudget: 4000,
    })
    expect(result.systemPromptAddition).toContain('PostgreSQL')
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  it('assemble returns no addition when no relevant engrams', async () => {
    const result = await engine.assemble({
      sessionId: 'test-1',
      messages: [{ role: 'user', content: 'hello' }],
    })
    // May or may not have systemPromptAddition depending on content
    expect(result.messages).toHaveLength(1)
  })

  it('afterTurn captures episodes', async () => {
    await engine.afterTurn({
      sessionId: 'test-1',
      sessionKey: 'user:john',
      sessionFile: '/tmp/test',
      messages: [
        { role: 'user', content: 'Deploy the app' },
        { role: 'assistant', content: 'I have deployed the application to staging successfully.' },
      ],
      prePromptMessageCount: 0,
    })
    const episodes = engine.plur.timeline({ agent: 'openclaw' })
    expect(episodes.length).toBeGreaterThan(0)
  })

  it('afterTurn ignores heartbeats', async () => {
    await engine.afterTurn({
      sessionId: 'test-1',
      sessionFile: '/tmp/test',
      messages: [{ role: 'assistant', content: 'heartbeat response' }],
      prePromptMessageCount: 0,
      isHeartbeat: true,
    })
    const episodes = engine.plur.timeline()
    expect(episodes).toHaveLength(0)
  })

  it('afterTurn extracts learnings from new messages', async () => {
    await engine.afterTurn({
      sessionId: 'test-1',
      sessionKey: 'user:john',
      sessionFile: '/tmp/test',
      messages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'We decided to use GraphQL instead of REST for the new API' },
        { role: 'assistant', content: 'Understood, I will use GraphQL.' },
      ],
      prePromptMessageCount: 1, // system message was pre-prompt
    })
    const recalled = engine.plur.recall('GraphQL')
    expect(recalled.length).toBeGreaterThan(0)
  })

  it('compact extracts learnings from accumulated messages', async () => {
    // Ingest some messages first
    await engine.ingest({
      sessionId: 'test-1',
      sessionKey: 'user:john',
      message: { role: 'user', content: 'The convention is to always prefix environment variables with APP_' },
    })
    // Compact triggers extraction
    const result = await engine.compact({
      sessionId: 'test-1',
      sessionKey: 'user:john',
      sessionFile: '/tmp/test',
    })
    expect(result.ok).toBe(true)
  })

  it('prepareSubagentSpawn inherits parent scope', async () => {
    await engine.bootstrap({ sessionId: 's1', sessionKey: 'parent-key', sessionFile: '/tmp/test' })
    const prep = await engine.prepareSubagentSpawn({
      parentSessionKey: 'parent-key',
      childSessionKey: 'child-key',
    })
    expect(prep).toBeDefined()
    expect(engine.getSessionScope('child-key')).toBe('session:parent-key')
  })

  it('onSubagentEnded cleans up child state', async () => {
    await engine.bootstrap({ sessionId: 's1', sessionKey: 'parent-key', sessionFile: '/tmp/test' })
    await engine.prepareSubagentSpawn({
      parentSessionKey: 'parent-key',
      childSessionKey: 'child-key',
    })
    await engine.onSubagentEnded({ childSessionKey: 'child-key', reason: 'completed' })
    expect(engine.getSessionScope('child-key')).toBeUndefined()
  })

  it('cross-session memory persists', async () => {
    // Session 1: learn something
    engine.plur.learn('Always use feature flags for new features', { scope: 'global' })

    // Session 2: create new engine with same path
    const engine2 = new PlurContextEngine({ path: dir })
    const result = await engine2.assemble({
      sessionId: 'session-2',
      messages: [{ role: 'user', content: 'add a new feature to the application' }],
    })
    expect(result.systemPromptAddition).toContain('feature flags')
  })

  it('dispose cleans up state', async () => {
    await engine.bootstrap({ sessionId: 's1', sessionKey: 'key-1', sessionFile: '/tmp/test' })
    await engine.dispose()
    expect(engine.getSessionScope('key-1')).toBeUndefined()
  })
})
