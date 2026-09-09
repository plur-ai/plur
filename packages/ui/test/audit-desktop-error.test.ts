import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createUiServer } from '../src/server.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref(): void }
    child.unref = () => {}
    queueMicrotask(() => child.emit('error', Object.assign(new Error('desktop executable absent'), { code: 'ENOENT' })))
    return child
  }),
}))

it('survives an asynchronous failure from the optional desktop launcher', async () => {
  const server = createUiServer({ load: async () => [], where: '', openPath: '/tmp/audit-disposable' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no local address')
  const base = `http://127.0.0.1:${address.port}`
  try {
    expect((await fetch(`${base}/open-store`, { method: 'POST', headers: { origin: base }, redirect: 'manual' })).status).toBe(303)
    expect((await fetch(base)).status).toBe(200)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
