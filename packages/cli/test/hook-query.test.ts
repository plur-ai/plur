/**
 * W5 (overhaul): the Claude Code hook builds the query from session context
 * when the prompt is vague (fewer than `injection.query_min_terms` content
 * words) or is an event label ("skill: X"): the stored session task, the
 * project scope label, the git branch, and the last two user turns from the
 * payload's transcript. Every read is bounded and never throws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import {
  contentWordCount, isEventLabel, readGitBranch, readLastUserTurns, buildHookQueryContext, scopeLabel,
} from '../src/lib/hook-query.js'

describe('content words and event labels', () => {
  it('counts content words, not stopwords, digits or punctuation', () => {
    expect(contentWordCount('do 1,2,3')).toBe(0)
    expect(contentWordCount('ok go ahead with that')).toBe(0)
    expect(contentWordCount('fix the invoice exporter retries')).toBe(4)
  })
  it('recognises the hook event labels', () => {
    expect(isEventLabel('skill: review')).toBe(true)
    expect(isEventLabel('agent: Explore find the config')).toBe(true)
    expect(isEventLabel('subagent: general-purpose')).toBe(true)
    expect(isEventLabel('skill invocation')).toBe(true)
    expect(isEventLabel('fix the skill loader')).toBe(false)
  })
  it('labels a scope for search', () => {
    expect(scopeLabel('project:invoice-tools')).toBe('invoice tools')
    expect(scopeLabel('group:acme/eng')).toBe('acme eng')
    expect(scopeLabel(undefined)).toBe('')
  })
})

describe('bounded reads', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-hookq-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the branch from .git/HEAD, walking up; null when detached or absent', () => {
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/invoice-retries\n')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    expect(readGitBranch(join(dir, 'a', 'b'))).toBe('feat/invoice-retries')
    writeFileSync(join(dir, '.git', 'HEAD'), '3f2a9c0d1e\n')
    expect(readGitBranch(dir)).toBeNull()
    expect(readGitBranch(join(dir, 'nope'))).toBeNull()
  })

  it('follows a worktree .git file to its gitdir', () => {
    const gd = join(dir, 'gitdir')
    mkdirSync(gd)
    writeFileSync(join(gd, 'HEAD'), 'ref: refs/heads/ws/a\n')
    mkdirSync(join(dir, 'wt'))
    writeFileSync(join(dir, 'wt', '.git'), `gitdir: ${gd}\n`)
    expect(readGitBranch(join(dir, 'wt'))).toBe('ws/a')
  })

  it('takes the last two user turns from a transcript, skipping tool results and tagged system text', () => {
    const t = join(dir, 't.jsonl')
    const lines = [
      { type: 'user', message: { role: 'user', content: 'first: set up the invoice exporter' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second: make uploads retry' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      'not json at all',
      { type: 'user', message: { role: 'user', content: 'third: to the ledger bucket' } },
    ]
    writeFileSync(t, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
    expect(readLastUserTurns(t, 2)).toEqual(['second: make uploads retry', 'third: to the ledger bucket'])
  })

  it('never throws on a missing, unreadable or huge transcript, and reads only its tail', () => {
    expect(readLastUserTurns(join(dir, 'missing.jsonl'))).toEqual([])
    expect(readLastUserTurns(undefined)).toEqual([])
    expect(readLastUserTurns(dir)).toEqual([]) // a directory
    const big = join(dir, 'big.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'old turn '.repeat(50) } })
    writeFileSync(big, `${filler}\n`.repeat(4000) + JSON.stringify({ type: 'user', message: { role: 'user', content: 'latest turn' } }) + '\n')
    const turns = readLastUserTurns(big, 2, 64 * 1024)
    expect(turns[turns.length - 1]).toBe('latest turn')
  })
})

describe('buildHookQueryContext', () => {
  it('extends a vague prompt; leaves a specific one alone', () => {
    const vague = buildHookQueryContext({ prompt: 'do 1,2,3', isEvent: false, sessionTask: 'fix the invoice exporter', scope: 'project:billing', branch: 'feat/retries', turns: ['make it retry'], minTerms: 4 })
    expect(vague.extended).toBe(true)
    expect(vague.context).toEqual(['fix the invoice exporter', 'billing', 'feat retries', 'make it retry'])
    const specific = buildHookQueryContext({ prompt: 'fix the invoice exporter upload retries', isEvent: false, sessionTask: 'x', scope: undefined, branch: null, turns: [], minTerms: 4 })
    expect(specific).toEqual({ extended: false, context: [] })
  })
  it('always extends an event label', () => {
    const ev = buildHookQueryContext({ prompt: 'skill: review code quality and correctness', isEvent: true, sessionTask: 'fix the exporter', scope: undefined, branch: null, turns: [], minTerms: 4 })
    expect(ev.extended).toBe(true)
    expect(ev.context).toEqual(['fix the exporter'])
  })
})

describe('vague prompt + stored session task retrieves the task engram (W5)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-hookq-store-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the raw prompt does not; the built query does', async () => {
    const plur = new Plur({ path: dir })
    const target = await plur.learn('The invoice exporter retries failed uploads to the ledger bucket three times.', { scope: 'global', type: 'behavioral' })
    await plur.learn('Coffee orders for the office go through the kitchen channel.', { scope: 'global', type: 'behavioral' })
    const raw = await plur.inject('do 1,2,3', { source: 'hook' })
    expect(raw.injected_ids).not.toContain(target.id)
    const { context } = buildHookQueryContext({ prompt: 'do 1,2,3', isEvent: false, sessionTask: 'fix the invoice exporter upload retries', scope: undefined, branch: null, turns: [], minTerms: 4 })
    const built = await plur.inject('do 1,2,3', { source: 'hook', query_context: context })
    expect(built.injected_ids).toContain(target.id)
    expect(built.query).toContain('invoice exporter')
  })
})
