import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PushRouter, requestOverPort } from './transport'

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
