import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquirePort, getInitialPath, type HandshakeEnv, NO_PORT_ERROR } from './handshake'
import type { OcGlobal } from '@mythwork/protocol'

// A fake HandshakeEnv: an in-process EventTarget standing in for `window`, plus
// a controllable "host" that replies to oc-ping with oc-init carrying a
// transferred MessagePort. This unit-tests the handshake STATE MACHINE without
// real globals (the injectable seam from connect({ env })).

class FakeEnv implements HandshakeEnv {
  private readonly target = new EventTarget()
  private oc: OcGlobal | undefined
  /** Pings the fake host has received. */
  readonly pings: unknown[] = []
  /** When set, the host replies to each ping by transferring this port via oc-init. */
  private hostPort: MessagePort | null = null
  private hostInitialPath: string | undefined
  private embedded = true

  setHostPort(port: MessagePort | null, initialPath?: string) {
    this.hostPort = port
    this.hostInitialPath = initialPath
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
      const evt = new Event('message') as Event & {
        data?: unknown
        ports?: readonly MessagePort[]
      }
      evt.data = {
        type: 'oc-init',
        shareBaseOrigin: 'https://lab.example',
        initialPath: this.hostInitialPath,
      }
      evt.ports = [port]
      this.dispatchEvent(evt)
    }
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

  it('path (b): captures the host-supplied initialPath alongside the port', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setHostPort(chan.port2, '/showcase')
    await acquirePort(env)
    expect(getInitialPath(env)).toBe('/showcase')
    chan.port1.close()
    chan.port2.close()
  })
})

describe('getInitialPath', () => {
  it('is undefined when the host never supplied one (e.g. a build that predates this field)', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setHostPort(chan.port2) // no initialPath
    await acquirePort(env)
    expect(getInitialPath(env)).toBeUndefined()
    chan.port1.close()
    chan.port2.close()
  })
})
