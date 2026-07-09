import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquirePort, type HandshakeEnv, NO_PORT_ERROR } from './handshake'
import type { OcGlobal } from '@mythwork/protocol'

// A fake HandshakeEnv: an in-process EventTarget standing in for `window`, plus
// a controllable "host" that replies to oc-ping with oc-init carrying a
// transferred MessagePort. This unit-tests the handshake STATE MACHINE without
// real globals (the injectable seam from connect({ env })).

/** Opaque stand-in for a `Window` object — used only for `===` identity, mirroring how `MessageEvent.source` works in a real browser. */
type FakeWindow = { readonly label: string }

class FakeEnv implements HandshakeEnv {
  private readonly target = new EventTarget()
  private oc: OcGlobal | undefined
  /** Pings the fake host has received. */
  readonly pings: unknown[] = []
  /** When set, the host replies to each ping by transferring this port via oc-init. */
  private hostPort: MessagePort | null = null
  private embedded = true
  /** The fake `window.parent` this env trusts — the only valid `oc-init` sender. */
  readonly hostWindow: FakeWindow = { label: 'host' }

  setHostPort(port: MessagePort | null) {
    this.hostPort = port
  }
  setEmbedded(v: boolean) {
    this.embedded = v
  }

  addEventListener(type: string, listener: (e: Event) => void): void {
    this.target.addEventListener(type, listener as EventListener)
  }
  removeEventListener(type: string, listener: (e: Event) => void): void {
    this.target.removeEventListener(type, listener as EventListener)
  }
  dispatchEvent(event: Event): void {
    this.target.dispatchEvent(event)
  }
  postToHost(message: unknown): void {
    this.pings.push(message)
    // Emulate the deployed host (host-iframe/src/db/index.ts): on the first
    // oc-ping, reply oc-init transferring the port to our 'message' listener.
    if (this.hostPort && (message as { type?: string })?.type === 'oc-ping') {
      const port = this.hostPort
      this.hostPort = null
      this.dispatchMessage({ type: 'oc-init', shareBaseOrigin: 'https://lab.example' }, [port], this.hostWindow)
    }
  }
  /** Dispatch a raw `'message'` event as if it came from `source` — used to simulate both the real host and a spoofing attacker. */
  dispatchMessage(data: unknown, ports: readonly MessagePort[], source: unknown): void {
    const evt = new Event('message') as Event & {
      data?: unknown
      ports?: readonly MessagePort[]
      source?: unknown
    }
    evt.data = data
    evt.ports = ports
    evt.source = source
    this.dispatchEvent(evt)
  }
  getOcGlobal(): OcGlobal | undefined {
    return this.oc
  }
  setOcGlobal(value: OcGlobal): void {
    this.oc = value
  }
  hasParent(): boolean {
    return this.embedded
  }
  isHostSource(source: unknown): boolean {
    return source === this.hostWindow
  }
}

describe('acquirePort', () => {
  afterEach(() => vi.useRealTimers())

  it('path (a): adopts a port a platform bootstrap already installed', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setOcGlobal({ port: chan.port1 })
    const port = await acquirePort(env)
    expect(port).toBe(chan.port1)
    expect(env.pings).toHaveLength(0) // never needed to ping
    chan.port1.close()
    chan.port2.close()
  })

  it('path (a): discovers a port installed later via the ocready event', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setEmbedded(false) // not embedded, so no self-ping loop
    const pending = acquirePort(env)
    // Simulate the bootstrap installing the port then firing ocready.
    env.setOcGlobal({ port: chan.port1 })
    env.dispatchEvent(new Event('ocready'))
    expect(await pending).toBe(chan.port1)
    chan.port1.close()
    chan.port2.close()
  })

  it('path (b): runs the oc-ping loop and adopts the host-transferred port', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setHostPort(chan.port2)
    const port = await acquirePort(env)
    expect(port).toBe(chan.port2)
    expect(env.pings).toEqual([{ type: 'oc-ping' }])
    // The client installed it at window.__oc.port for co-resident transports.
    expect(env.getOcGlobal()?.port).toBe(chan.port2)
    chan.port1.close()
    chan.port2.close()
  })

  it('rejects with NO_PORT_ERROR when no port appears within the budget', async () => {
    vi.useFakeTimers()
    const env = new FakeEnv() // host never replies (no hostPort set)
    const p = acquirePort(env, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(NO_PORT_ERROR)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('path (b): ignores a spoofed oc-init from a non-host source and still adopts the real host port', async () => {
    const env = new FakeEnv()
    const attackerChan = new MessageChannel()
    const hostChan = new MessageChannel()
    const attacker: FakeWindow = { label: 'attacker' }

    const pending = acquirePort(env)

    // A sibling frame / injected script races the real host, posting a
    // same-shaped oc-init from a different source.
    env.dispatchMessage({ type: 'oc-init', shareBaseOrigin: 'https://evil.example' }, [attackerChan.port2], attacker)

    // The real host now replies.
    env.dispatchMessage({ type: 'oc-init', shareBaseOrigin: 'https://lab.example' }, [hostChan.port2], env.hostWindow)

    const port = await pending
    expect(port).toBe(hostChan.port2)
    expect(port).not.toBe(attackerChan.port2)
    expect(env.getOcGlobal()?.port).toBe(hostChan.port2)

    attackerChan.port1.close()
    attackerChan.port2.close()
    hostChan.port1.close()
    hostChan.port2.close()
  })

  it('path (b): a spoofed-only oc-init (no legitimate host reply) times out rather than being adopted', async () => {
    vi.useFakeTimers()
    const env = new FakeEnv()
    const attackerChan = new MessageChannel()
    const attacker: FakeWindow = { label: 'attacker' }

    const p = acquirePort(env, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(NO_PORT_ERROR)

    env.dispatchMessage({ type: 'oc-init', shareBaseOrigin: 'https://evil.example' }, [attackerChan.port2], attacker)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    attackerChan.port1.close()
    attackerChan.port2.close()
  })

  it('path (a): a non-MessagePort value pre-installed at window.__oc.port is not adopted', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    // Simulate a same-window script pre-populating the global with a forged,
    // non-transferable stand-in before connect() runs.
    env.setOcGlobal({ port: { postMessage: () => {}, start: () => {} } as unknown as MessagePort })
    // The real host is ready to reply over the legitimate ping/oc-init path.
    env.setHostPort(chan.port2)

    const port = await acquirePort(env)
    expect(port).toBe(chan.port2)
    // The fast path never short-circuited on the forged value.
    expect(env.pings).toEqual([{ type: 'oc-ping' }])
    chan.port1.close()
    chan.port2.close()
  })
})
