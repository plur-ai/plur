import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ instances: [] as any[], policy: new Map<string, any>() }))
vi.mock('@plur-ai/core', async original => {
  const actual = await original<typeof import('@plur-ai/core')>()
  return { ...actual,
    Plur: vi.fn(function(this: any, options: any) {
      this.options = options
      this.storageRoot = process.env.PLUR_PATH
      this.config = { auto_learn: true }
      this.resolveFolderPolicy = vi.fn((dir: string) => fake.policy.get(dir) ?? { mode: 'on', source: 'map', scope: 'local', remoteAllowed: false })
      this.isDirectoryTrusted = () => false
      this.injectHybrid = vi.fn(async () => ({ marker: options.cwd }))
      this.learnRouted = vi.fn(async () => ({}))
      this.endFolderNonceSession = vi.fn()
      this.close = vi.fn()
      fake.instances.push(this)
    }),
    renderMemoryBlock: ({ injection }: any) => `memory:${injection.marker}`,
    skippedStoreNotice: () => '',
  }
})
const { default: definition } = await import('../src/index.js')
const tick = async () => { for (let i=0;i<20;i++) await new Promise(r => setTimeout(r, 0)) }
const user = (id: string, text = 'No, the API uses snake_case not camelCase.') => ({ id, type: 'user', text })
const report = '---\n🧠 I learned:\n- Tests must run before merging.'
const closers: Array<() => Promise<void>> = []
function host(storage = new Map<string, any>()) {
  const hooks = new Map<string, any>()
  const locations = new Map([['s1', '/project/one'], ['s2', '/project/two']])
  const history = new Map<string, any[]>([['s1', [user('u1')]], ['s2', [user('u2')]]])
  const queue: any[] = []; let wake: (() => void) | undefined
  const ctx = {
    location: { directory: '/wrong/plugin-load-folder' },
    session: {
      hook: vi.fn(async (name: string, cb: any) => { hooks.set(name, cb); return { dispose: async () => { hooks.delete(name) } } }),
      get: vi.fn(async ({ sessionID }: any) => ({ id: sessionID, location: { directory: locations.get(sessionID) } })),
      context: vi.fn(async ({ sessionID }: any) => history.get(sessionID) ?? []),
    },
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      set: vi.fn(async (key: string, value: any) => { storage.set(key, structuredClone(value)) }),
      remove: vi.fn(async (key: string) => { storage.delete(key) }),
    },
    event: { subscribe: ({ signal }: any) => (async function* () {
      signal.addEventListener('abort', () => wake?.(), { once: true })
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>(r => { wake = r })
        while (queue.length && !signal.aborted) yield queue.shift()
      }
    })() },
  }
  return { ctx, hooks, history, locations, storage,
    async start() {
      const close = await (definition as any).setup(ctx)
      closers.push(close); return close as () => Promise<void>
    },
    async context(id = 's1', kind = 'context') {
      const request = { sessionID: id, system: [], messages: [], tools: {} }
      await hooks.get(kind)(request); return request
    },
    async event(type: string, data: any) { queue.push({ type, data }); wake?.(); await tick() },
  }
}
beforeEach(() => { fake.instances.length = 0; fake.policy.clear() })
afterEach(async () => { for (const close of closers.splice(0)) await close() })

describe('V2 canonical lifecycle', () => {
  it('registers context/compaction, learns only admitted messages, and never injects into history', async () => {
    const h = host(); await h.start()
    expect(h.hooks.has('prompt')).toBe(false)
    const first = await h.context(); const next = await h.context()
    await tick()
    expect(first.system).toEqual([{ type: 'text', text: 'memory:/project/one' }])
    expect(next.system).toEqual(first.system)
    expect(first.messages).toEqual([])
    expect(fake.instances[0].options).toMatchObject({ cwd: '/project/one', autoDiscover: false })
    expect(fake.instances[0].injectHybrid).toHaveBeenCalledTimes(1)
    expect(fake.instances[0].learnRouted).toHaveBeenCalledTimes(1)
  })
  it('keeps concurrently active sessions in their actual folders', async () => {
    const h=host(); await h.start()
    const [a,b]=await Promise.all([h.context('s1'),h.context('s2')])
    expect(a.system).toEqual([{ type:'text',text:'memory:/project/one' }])
    expect(b.system).toEqual([{ type:'text',text:'memory:/project/two' }])
  })
  it('does not harvest old history, but captures every newly admitted user in a batch', async () => {
    const h=host(); h.history.set('s1',[user('old'),{id:'a0',type:'assistant'},user('u1'),user('u3')])
    await h.start(); await h.context(); await tick()
    expect(fake.instances[0].learnRouted).toHaveBeenCalledTimes(2)
  })
  it('remembers processed user IDs across a normal plugin reload', async () => {
    const storage=new Map(); const h=host(storage); const close=await h.start()
    await h.context(); await close()
    const next=host(storage); await next.start(); await next.context(); await tick()
    expect(fake.instances.map(p=>p.learnRouted.mock.calls.length)).toEqual([1,0])
    expect(JSON.stringify([...storage.values()])).not.toContain('snake_case')
  })
  it('marks off-folder messages without learning them later when enabled', async () => {
    fake.policy.set('/project/one',{mode:'off',source:'map',remoteAllowed:false})
    const h=host(); await h.start(); expect((await h.context()).system).toEqual([])
    expect(fake.instances[0].injectHybrid).not.toHaveBeenCalled()
    fake.policy.delete('/project/one'); await h.context(); await tick()
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
  })
  it('drops cached recall when policy changes during the request', async () => {
    const h=host(); await h.start(); await h.context()
    fake.policy.set('/project/one',{mode:'off',source:'map',remoteAllowed:false})
    expect((await h.context()).system).toEqual([])
    expect((await h.context('s1','compaction')).system).toEqual([])
  })
  it('does not construct memory for unrelated events', async () => {
    const h=host(); await h.start()
    await h.event('session.step.started', { sessionID: 'foreign', assistantMessageID: 'a', started: Date.now() })
    await h.event('session.text.ended',{sessionID:'foreign',assistantMessageID:'a',ordinal:0,text:report})
    await h.event('session.execution.succeeded',{sessionID:'foreign'})
    expect(fake.instances).toEqual([])
  })
  it('learns complete assistant snapshots once at execution success, without idle', async () => {
    const h=host(); h.history.set('s1',[user('u1','hello')]); await h.start(); await h.context()
    const data={sessionID:'s1',assistantMessageID:'a1',ordinal:0,text:report}
    await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'a1', started: Date.now() })
    await h.event('session.text.ended',data); await h.event('session.text.ended',data)
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
    await h.event('session.execution.succeeded',{sessionID:'s1'})
    await h.event('session.execution.succeeded',{sessionID:'s1'})
    expect(fake.instances[0].learnRouted).toHaveBeenCalledTimes(1)
  })
  it.each(['failed','interrupted'])('does not learn assistant text from %s executions', async outcome => {
    const h=host(); h.history.set('s1',[user('u1','hello')]); await h.start(); await h.context()
    await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'a1', started: Date.now() })
    await h.event('session.text.ended',{sessionID:'s1',assistantMessageID:'a1',ordinal:0,text:report})
    await h.event(`session.execution.${outcome}`,{sessionID:'s1'})
    await h.event('session.execution.succeeded',{sessionID:'s1'})
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
  })
  it('carries recall into compaction without harvesting unfinished text', async () => {
    const h=host(); h.history.set('s1',[user('u1','hello')]); await h.start(); await h.context()
    await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'a1', started: Date.now() })
    await h.event('session.text.ended',{sessionID:'s1',assistantMessageID:'a1',ordinal:0,text:report})
    expect((await h.context('s1','compaction')).system).toEqual([{type:'text',text:'memory:/project/one'}])
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
  })
  it('invalidates old memory on a move and never relearns the preceding prompt there', async () => {
    const h=host(); await h.start(); await h.context(); await tick()
    h.locations.set('s1','/project/two')
    h.history.set('s1',[user('u1'),{id:'move',type:'location-switched'}])
    await h.event('session.moved',{sessionID:'s1'})
    await h.context(); await tick()
    expect(fake.instances[0].close).toHaveBeenCalledTimes(1)
    expect(fake.instances.flatMap(p=>p.learnRouted.mock.calls)).toHaveLength(1)
  })
  it('waits for owned learning before cleanup and closes each memory instance once', async () => {
    const h=host(); await h.start(); await h.context(); await tick()
    await closers[0](); await closers[0]()
    expect(fake.instances[0].close).toHaveBeenCalledTimes(1)
  })
  it('reports an unreadable folder map even when the CLI is missing', async () => {
    fake.policy.set('/project/one', { mode: 'ask', source: 'default', remoteAllowed: false, reason: 'malformed-map' })
    const oldPath = process.env.PATH
    process.env.PATH = ''
    try {
      const h = host(); await h.start()
      const result = await h.context()
      expect(JSON.stringify(result.system)).toContain('folder map cannot be read')
      expect(fake.instances[0].injectHybrid).not.toHaveBeenCalled()
    } finally { process.env.PATH = oldPath }
  })
  it('rechecks policy between separate writes from one completed assistant message', async () => {
    const h = host(); h.history.set('s1', [user('u1', 'hello')]); await h.start(); await h.context()
    let release!: () => void
    const pending = new Promise<void>(r => { release = r })
    fake.instances[0].learnRouted.mockImplementationOnce(() => pending)
    try {
      await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'a1', started: Date.now() })
    await h.event('session.text.ended', { sessionID:'s1', assistantMessageID:'a1', ordinal:0,
        text: report + '\n- Always review the public artifact before publishing.' })
      await h.event('session.execution.succeeded', { sessionID:'s1' })
      expect(fake.instances[0].learnRouted).toHaveBeenCalledTimes(1)
      fake.policy.set('/project/one', { mode:'off', source:'map', remoteAllowed:false })
      release(); await tick()
      expect(fake.instances[0].learnRouted).toHaveBeenCalledTimes(1)
    } finally { release() }
  })

  it('drops a slow recall and its correction when the folder is turned off while awaiting it', async () => {
    const h = host(); h.history.set('s1', [user('u0', 'hello')]); await h.start(); await h.context()
    let release!: (value: any) => void
    const pending = new Promise(r => { release = r })
    fake.instances[0].injectHybrid.mockImplementationOnce(() => pending)
    h.history.set('s1', [user('u1')])
    const request = h.context()
    await tick()
    fake.policy.set('/project/one', { mode: 'off', source: 'map', remoteAllowed: false })
    release({ marker: 'must-not-render' })
    expect((await request).system).toEqual([])
    await tick()
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
  })
  it('never redirects buffered assistant text to a newly selected team scope', async () => {
    const h = host(); h.history.set('s1', [user('u0', 'hello')]); await h.start(); await h.context()
    await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'a1', started: Date.now() })
    await h.event('session.text.ended', { sessionID: 's1', assistantMessageID: 'a1', ordinal: 0, text: report })
    fake.policy.set('/project/one', { mode: 'on', source: 'map', scope: 'group:example/new', remoteAllowed: true })
    await h.context()
    await h.event('session.execution.succeeded', { sessionID: 's1' })
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
    expect(fake.instances[0].injectHybrid.mock.calls.at(-1)[1].scope).toBe('group:example/new')
  })
  it('lets another session render while a learning write is pending and drains that write at cleanup', async () => {
    const h = host(); h.history.set('s1', [user('u0', 'hello')]); const close = await h.start(); await h.context()
    let release!: () => void
    const pending = new Promise<void>(r => { release = r })
    fake.instances[0].learnRouted.mockImplementationOnce(() => pending)
    try {
      await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'a1', started: Date.now() })
    await h.event('session.text.ended', { sessionID: 's1', assistantMessageID: 'a1', ordinal: 0, text: report })
      await h.event('session.execution.succeeded', { sessionID: 's1' })
      expect((await h.context('s2')).system).toEqual([{ type: 'text', text: 'memory:/project/two' }])
      let closed = false
      const closing = close().then(() => { closed = true })
      await tick(); expect(closed).toBe(false)
      release(); await closing
      expect(fake.instances[0].close).toHaveBeenCalledTimes(1)
    } finally { release() }
  })
  it('unregisters the first hook if registering the second fails', async () => {
    const h = host()
    h.ctx.session.hook.mockImplementationOnce(async (name, cb) => {
      h.hooks.set(name, cb); return { dispose: async () => { h.hooks.delete(name) } }
    }).mockRejectedValueOnce(new Error('registration refused'))
    await h.start()
    expect(h.hooks.size).toBe(0)
  })
  it('deleting a session removes its persisted identifiers and closes its owned memory instance', async () => {
    const h = host(); await h.start(); await h.context()
    await h.event('session.deleted', { sessionID: 's1' })
    expect(h.storage.has('sessions/s1/processed-v2')).toBe(false)
    expect(fake.instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('rejects a late assistant completion after a scope change even when the new context has rendered', async () => {
    const h = host(); h.history.set('s1', [user('u0', 'hello')]); await h.start(); await h.context()
    await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'old', started: Date.now() })
    fake.policy.set('/project/one', { mode: 'on', source: 'map', scope: 'group:example/new', remoteAllowed: true })
    await h.context()
    await h.event('session.text.ended', { sessionID: 's1', assistantMessageID: 'old', ordinal: 0, text: report })
    await h.event('session.execution.succeeded', { sessionID: 's1' })
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
  })
  it('rejects a delayed step start from before the current folder policy was observed', async () => {
    const h = host(); h.history.set('s1', [user('u0', 'hello')]); await h.start(); await h.context()
    await h.event('session.step.started', { sessionID: 's1', assistantMessageID: 'old', started: 1 })
    await h.event('session.text.ended', { sessionID: 's1', assistantMessageID: 'old', ordinal: 0, text: report })
    await h.event('session.execution.succeeded', { sessionID: 's1' })
    expect(fake.instances[0].learnRouted).not.toHaveBeenCalled()
  })

})
