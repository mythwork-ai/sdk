import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PushRouter, requestOverPort, streamOverPort } from './transport'

// A synchronous mock MessagePort: `deliver(data)` fans a `{ data }` MessageEvent
// out to every installed listener in-line, so tests are deterministic under fake
// timers and can assert precise listener-removal (leak checks). `posted` records
// every outbound postMessage.
function makeMockPort() {
  const listeners = new Set<(e: MessageEvent) => void>()
  const posted: Array<Record<string, unknown>> = []
  const port = {
    addEventListener(type: string, h: EventListenerOrEventListenerObject) {
      if (type === 'message') listeners.add(h as (e: MessageEvent) => void)
    },
    removeEventListener(type: string, h: EventListenerOrEventListenerObject) {
      if (type === 'message') listeners.delete(h as (e: MessageEvent) => void)
    },
    postMessage(data: unknown) {
      posted.push(data as Record<string, unknown>)
    },
  } as unknown as MessagePort
  const deliver = (data: unknown) => {
    for (const h of [...listeners]) h({ data } as MessageEvent)
  }
  return { port, posted, deliver, listenerCount: () => listeners.size }
}

// A node MessageChannel gives us two real, linked MessagePorts. We drive the
// "host" side (port2) by hand to emulate replies and pushes.

describe('requestOverPort', () => {
  let chan: MessageChannel
  beforeEach(() => {
    chan = new MessageChannel()
    chan.port2.start()
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
    vi.useRealTimers()
  })

  it('correlates interleaved concurrent requests by id', async () => {
    // Host echoes each request's id back with a result derived from the method,
    // but replies in REVERSE order to prove correlation isn't positional.
    const seen: { id: string; method: string }[] = []
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string }
      seen.push({ id: d.id, method: d.method })
    })
    const a = requestOverPort<string>(chan.port1, 'a', {})
    const b = requestOverPort<string>(chan.port1, 'b', {})
    const c = requestOverPort<string>(chan.port1, 'c', {})

    // Let the three requests flush to the host side. MessagePort delivery is
    // not bound to a single macrotask under load, so poll instead of a lone
    // setTimeout(0) (which flaked when the suite ran inside the pre-commit
    // gauntlet).
    const deadline = Date.now() + 2000
    while (seen.length < 3 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5))
    }
    expect(seen.map(s => s.method)).toEqual(['a', 'b', 'c'])
    // Reply out of order.
    chan.port2.postMessage({ id: seen[1]!.id, result: 'B' })
    chan.port2.postMessage({ id: seen[2]!.id, result: 'C' })
    chan.port2.postMessage({ id: seen[0]!.id, result: 'A' })

    expect(await a).toBe('A')
    expect(await b).toBe('B')
    expect(await c).toBe('C')
  })

  it('rejects with the wire error string on an { error } reply', async () => {
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string }
      chan.port2.postMessage({ id: d.id, error: 'boom: not allowed' })
    })
    await expect(requestOverPort(chan.port1, 'x', {})).rejects.toThrow('boom: not allowed')
  })

  it('rejects with a timeout error when no reply arrives (per-request timeoutMs)', async () => {
    vi.useFakeTimers()
    const p = requestOverPort(chan.port1, 'slow', {}, { timeoutMs: 1000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  it('applies the protocol default timeout when none is given', async () => {
    vi.useFakeTimers()
    const p = requestOverPort(chan.port1, 'slow', {})
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/)
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })
})

describe('streamOverPort', () => {
  afterEach(() => vi.useRealTimers())

  it('posts stream:true, forwards deltas in order, resolves on the terminal reply', async () => {
    const { port, posted, deliver } = makeMockPort()
    const chunks: string[] = []
    const p = streamOverPort<{ text: string }>(
      port,
      'ai.generate',
      { prompt: 'hi' },
      {
        onChunk: d => chunks.push(d),
      },
    )
    expect(posted[0]).toMatchObject({
      method: 'ai.generate',
      args: { prompt: 'hi', stream: true },
    })
    const id = posted[0]!.id as string
    deliver({ type: 'ai.delta', requestId: id, delta: 'a' })
    deliver({ type: 'ai.delta', requestId: id, delta: 'b' })
    deliver({ type: 'ai.delta', requestId: id, delta: 'c' })
    deliver({ id, result: { text: 'abc' } })
    await expect(p).resolves.toEqual({ text: 'abc' })
    expect(chunks).toEqual(['a', 'b', 'c'])
  })

  it('ignores ai.delta pushes carrying a foreign requestId', async () => {
    const { port, posted, deliver } = makeMockPort()
    const chunks: string[] = []
    const p = streamOverPort(port, 'ai.generate', {}, { onChunk: d => chunks.push(d) })
    const id = posted[0]!.id as string
    deliver({ type: 'ai.delta', requestId: 'someone-else', delta: 'x' })
    deliver({ type: 'ai.delta', requestId: id, delta: 'y' })
    deliver({ id, result: 'ok' })
    await expect(p).resolves.toBe('ok')
    expect(chunks).toEqual(['y'])
  })

  it('rejects with the wire error string on an { error } terminal', async () => {
    const { port, posted, deliver, listenerCount } = makeMockPort()
    const p = streamOverPort(port, 'ai.generate', {}, { onChunk: () => {} })
    const id = posted[0]!.id as string
    deliver({ id, error: 'model refused' })
    await expect(p).rejects.toThrow('model refused')
    expect(listenerCount()).toBe(0)
  })

  it('aborts: rejects AbortError, posts { id, type: cancel }, removes all listeners', async () => {
    const { port, posted, listenerCount } = makeMockPort()
    const ac = new AbortController()
    const p = streamOverPort(port, 'ai.generate', {}, { onChunk: () => {}, signal: ac.signal })
    const id = posted[0]!.id as string
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(posted.some(m => m.id === id && m.type === 'cancel')).toBe(true)
    expect(listenerCount()).toBe(0)
  })

  it('rejects synchronously when the signal is already aborted', async () => {
    const { port, posted } = makeMockPort()
    const ac = new AbortController()
    ac.abort()
    const p = streamOverPort(port, 'ai.generate', {}, { onChunk: () => {}, signal: ac.signal })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    // Never even sent the request.
    expect(posted).toHaveLength(0)
  })

  it('resets the inactivity timeout on every delta (a long stream never trips it)', async () => {
    vi.useFakeTimers()
    const { port, posted, deliver } = makeMockPort()
    const chunks: string[] = []
    const p = streamOverPort(
      port,
      'ai.generate',
      {},
      {
        onChunk: d => chunks.push(d),
        timeoutMs: 1000,
      },
    )
    const id = posted[0]!.id as string
    let rejected = false
    p.catch(() => {
      rejected = true
    })
    // Each gap is 800ms (< 1000ms) but the cumulative time (2400ms) far exceeds
    // the base timeout — only the per-delta reset keeps it alive.
    await vi.advanceTimersByTimeAsync(800)
    deliver({ type: 'ai.delta', requestId: id, delta: 'a' })
    await vi.advanceTimersByTimeAsync(800)
    deliver({ type: 'ai.delta', requestId: id, delta: 'b' })
    await vi.advanceTimersByTimeAsync(800)
    expect(rejected).toBe(false)
    deliver({ id, result: 'done' })
    await expect(p).resolves.toBe('done')
    expect(chunks).toEqual(['a', 'b'])
  })

  it('trips the inactivity timeout when deltas stop arriving', async () => {
    vi.useFakeTimers()
    const { port, deliver } = makeMockPort()
    const p = streamOverPort(port, 'ai.generate', {}, { onChunk: () => {}, timeoutMs: 1000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    // A late delta after the timeout is a no-op (listener already removed).
    expect(() => deliver({ type: 'ai.delta', requestId: '0', delta: 'z' })).not.toThrow()
  })
})

describe('requestOverPort abort support', () => {
  it('rejects synchronously when the signal is already aborted', async () => {
    const { port, posted } = makeMockPort()
    const ac = new AbortController()
    ac.abort()
    const p = requestOverPort(port, 'x', {}, { signal: ac.signal })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(posted).toHaveLength(0)
  })

  it('rejects with AbortError, posts cancel, and removes the listener on abort', async () => {
    const { port, posted, listenerCount } = makeMockPort()
    const ac = new AbortController()
    const p = requestOverPort(port, 'x', {}, { signal: ac.signal })
    const id = posted[0]!.id as string
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(posted.some(m => m.id === id && m.type === 'cancel')).toBe(true)
    expect(listenerCount()).toBe(0)
  })
})

describe('PushRouter prefix matching', () => {
  let chan: MessageChannel
  let router: PushRouter
  beforeEach(() => {
    chan = new MessageChannel()
    router = new PushRouter()
    router.install(chan.port1)
    chan.port1.start()
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  // MessagePort delivery is async and, under pool contention, not bound to a
  // single macrotask — so a lone setTimeout(0) raced the dispatch and flaked in
  // the pre-commit gauntlet (same failure the requestOverPort block above fixed
  // by polling). Instead, post a sentinel push AFTER the message under test and
  // await its arrival: a single port delivers in FIFO order, so once the
  // sentinel routes the prior push has already been dispatched. Deterministic
  // for both positive (expect 1) and negative (expect 0) assertions.
  const settle = async () => {
    let seen = false
    const off = router.subscribe('__settle', () => {
      seen = true
    })
    chan.port2.postMessage({ type: '__settle' })
    const deadline = Date.now() + 2000
    while (!seen && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5))
    }
    off()
  }

  it("delivers 'fs.changed' to a bare 'fs' prefix subscriber", async () => {
    const hits: unknown[] = []
    router.subscribe('fs', m => hits.push(m))
    chan.port2.postMessage({ type: 'fs.changed', pid: 'p', path: 'a', kind: 'updated' })
    await settle()
    expect(hits).toHaveLength(1)
    expect((hits[0] as { type: string }).type).toBe('fs.changed')
  })

  it("does NOT deliver 'fsx.changed' to an 'fs' subscriber (segment-boundary guard)", async () => {
    const hits: unknown[] = []
    router.subscribe('fs', m => hits.push(m))
    chan.port2.postMessage({ type: 'fsx.changed', whatever: 1 })
    await settle()
    expect(hits).toHaveLength(0)
  })

  it('delivers on an exact full-type match', async () => {
    const hits: unknown[] = []
    router.subscribe('fs.changed', m => hits.push(m))
    chan.port2.postMessage({ type: 'fs.changed', pid: 'p', path: 'a', kind: 'added' })
    await settle()
    expect(hits).toHaveLength(1)
  })

  it('ignores id-correlated replies (only id-less pushes route)', async () => {
    const hits: unknown[] = []
    router.subscribe('fs', m => hits.push(m))
    chan.port2.postMessage({ id: '7', result: { type: 'fs.changed' } })
    await settle()
    expect(hits).toHaveLength(0)
  })

  it('unsubscribe stops delivery', async () => {
    const hits: unknown[] = []
    const off = router.subscribe('fs', m => hits.push(m))
    chan.port2.postMessage({ type: 'fs.changed', pid: 'p', path: 'a', kind: 'updated' })
    await settle()
    expect(hits).toHaveLength(1)
    off()
    chan.port2.postMessage({ type: 'fs.changed', pid: 'p', path: 'b', kind: 'updated' })
    await settle()
    expect(hits).toHaveLength(1)
  })
})
