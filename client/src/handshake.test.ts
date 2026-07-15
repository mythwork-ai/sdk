import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePort,
  getInitialPath,
  getShareBaseOrigin,
  type HandshakeEnv,
  NO_PORT_ERROR,
} from './handshake'
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
  private hostInitialPath: string | undefined
  private embedded = true
  /** The fake `window.parent` this env trusts — the only valid `oc-init` sender. */
  readonly hostWindow: FakeWindow = { label: 'host' }

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
      this.dispatchMessage(
        {
          type: 'oc-init',
          shareBaseOrigin: 'https://lab.example',
          initialPath: this.hostInitialPath,
        },
        [port],
        this.hostWindow,
      )
    }
  }
  /**
   * Dispatch a raw `'message'` event as if it came from `source` — used to
   * simulate both the real host and a source-spoofing attacker (a sibling
   * frame/different window genuinely posting a message, just not from
   * `window.parent`). Defaults `trusted: true` since both of those are real,
   * browser-delivered `postMessage` events — `isTrusted` only distinguishes
   * genuine delivery from a same-window script that constructs its own
   * `MessageEvent` and calls `dispatchEvent()` directly, which is what
   * `trusted: false` models (see the `isTrusted`-bypass test below).
   */
  dispatchMessage(
    data: unknown,
    ports: readonly MessagePort[],
    source: unknown,
    trusted = true,
  ): void {
    const evt = new Event('message') as Event & {
      data?: unknown
      ports?: readonly MessagePort[]
      source?: unknown
    }
    evt.data = data
    evt.ports = ports
    evt.source = source
    Object.defineProperty(evt, 'isTrusted', { value: trusted, configurable: true })
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

  it('path (a): reuses a port this module already verified via a prior handshake, without re-pinging', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setHostPort(chan.port2)
    // First call runs the real, source-checked handshake and verifies the port.
    const first = await acquirePort(env)
    expect(first).toBe(chan.port2)
    expect(env.pings).toEqual([{ type: 'oc-ping' }])
    // A second call (e.g. a co-resident consumer sharing the same page) takes
    // the fast path: the port is already installed AND already verified by
    // our own handshake, so no second ping round-trip is needed.
    const second = await acquirePort(env)
    expect(second).toBe(chan.port2)
    expect(env.pings).toEqual([{ type: 'oc-ping' }]) // no additional ping
    chan.port1.close()
    chan.port2.close()
  })

  it('path (a): a concurrent call converges on the port another call just verified, via ocready', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setEmbedded(false) // neither call self-pings; both just wait
    const first = acquirePort(env)
    const second = acquirePort(env)
    // Simulate the real host replying to the (embedded) handshake elsewhere —
    // here we drive it directly through the source-checked message path so
    // the port is genuinely verified before either call can adopt it.
    env.dispatchMessage(
      { type: 'oc-init', shareBaseOrigin: 'https://lab.example' },
      [chan.port2],
      env.hostWindow,
    )
    expect(await first).toBe(chan.port2)
    expect(await second).toBe(chan.port2)
    chan.port1.close()
    chan.port2.close()
  })

  it('path (a): a port merely PRESENT at window.__oc.port — never verified by this module — is not adopted', async () => {
    const env = new FakeEnv()
    const forged = new MessageChannel()
    const chan = new MessageChannel()
    // Simulate a same-window script (compromised dependency, injected script,
    // extension content script, XSS) pre-populating the global with a real,
    // genuine MessagePort before acquirePort() ever runs — no host involved.
    env.setOcGlobal({ port: forged.port1 })
    // The real host is ready to reply over the legitimate ping/oc-init path.
    env.setHostPort(chan.port2)

    const port = await acquirePort(env)
    // The unverified pre-installed port is never adopted; the module falls
    // through to running its own source-checked handshake and gets the real
    // host's port instead.
    expect(port).toBe(chan.port2)
    expect(port).not.toBe(forged.port1)
    expect(env.pings).toEqual([{ type: 'oc-ping' }]) // the fast path never short-circuited

    forged.port1.close()
    forged.port2.close()
    chan.port1.close()
    chan.port2.close()
  })

  it('adversarial: a pre-installed real MessagePort is never adopted even if isHostSource always returns false (no legitimate host present at all)', async () => {
    vi.useFakeTimers()
    const env = new FakeEnv()
    // Hardcode isHostSource to always reject — models a page where no
    // legitimate host reply can ever arrive (or, equivalently, an attacker who
    // has already defeated the source check by some other means). The ONLY
    // way to "win" here is via the fast path blindly trusting a pre-existing
    // window.__oc.port.
    Object.defineProperty(env, 'isHostSource', { value: () => false })
    const attackerChan = new MessageChannel()
    // Attacker pre-installs a genuine MessagePort before acquirePort() runs —
    // exactly the `window.__oc = { port: new MessageChannel().port1 }`
    // scenario a same-window attacker script can always perform.
    env.setOcGlobal({ port: attackerChan.port1 })

    const p = acquirePort(env, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(NO_PORT_ERROR)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    attackerChan.port1.close()
    attackerChan.port2.close()
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

  it('path (b): ignores a spoofed oc-init from a non-host source and still adopts the real host port', async () => {
    const env = new FakeEnv()
    const attackerChan = new MessageChannel()
    const hostChan = new MessageChannel()
    const attacker: FakeWindow = { label: 'attacker' }

    const pending = acquirePort(env)

    // A sibling frame / injected script races the real host, posting a
    // same-shaped oc-init from a different source.
    env.dispatchMessage(
      { type: 'oc-init', shareBaseOrigin: 'https://evil.example' },
      [attackerChan.port2],
      attacker,
    )

    // The real host now replies.
    env.dispatchMessage(
      { type: 'oc-init', shareBaseOrigin: 'https://lab.example' },
      [hostChan.port2],
      env.hostWindow,
    )

    const port = await pending
    expect(port).toBe(hostChan.port2)
    expect(port).not.toBe(attackerChan.port2)
    expect(env.getOcGlobal()?.port).toBe(hostChan.port2)

    attackerChan.port1.close()
    attackerChan.port2.close()
    hostChan.port1.close()
    hostChan.port2.close()
  })

  it('path (b): rejects a script-dispatched oc-init even when its `source` genuinely is `window.parent` (isTrusted bypass)', async () => {
    vi.useFakeTimers()
    const env = new FakeEnv()
    const attackerChan = new MessageChannel()

    const p = acquirePort(env, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(NO_PORT_ERROR)

    // A same-window attacker (compromised dependency, injected script,
    // extension content script, XSS) already holds the real `window.parent`
    // reference and can construct its own MessageEvent claiming that source,
    // then call `dispatchEvent()` directly — bypassing real cross-document
    // `postMessage` entirely. `source` alone can't catch this because the
    // source object genuinely IS `env.hostWindow` here; only `isTrusted`
    // (forced false for this call) can, since a real browser never sets
    // `isTrusted: true` on a script-constructed, script-dispatched event.
    env.dispatchMessage(
      { type: 'oc-init', shareBaseOrigin: 'https://evil.example' },
      [attackerChan.port2],
      env.hostWindow,
      false,
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(env.getOcGlobal()?.port).toBeUndefined()

    attackerChan.port1.close()
    attackerChan.port2.close()
  })

  it('path (b): a spoofed-only oc-init (no legitimate host reply) times out rather than being adopted', async () => {
    vi.useFakeTimers()
    const env = new FakeEnv()
    const attackerChan = new MessageChannel()
    const attacker: FakeWindow = { label: 'attacker' }

    const p = acquirePort(env, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(NO_PORT_ERROR)

    env.dispatchMessage(
      { type: 'oc-init', shareBaseOrigin: 'https://evil.example' },
      [attackerChan.port2],
      attacker,
    )
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

describe('getShareBaseOrigin', () => {
  it('captures the host-supplied outer origin alongside the port', async () => {
    const env = new FakeEnv()
    const chan = new MessageChannel()
    env.setHostPort(chan.port2)
    await acquirePort(env)
    // FakeEnv's host replies oc-init with shareBaseOrigin 'https://lab.example'
    // (mirroring the deployed host-iframe bridge).
    expect(getShareBaseOrigin(env)).toBe('https://lab.example')
    chan.port1.close()
    chan.port2.close()
  })

  it('is undefined before any handshake ran (dev/standalone)', () => {
    expect(getShareBaseOrigin(new FakeEnv())).toBeUndefined()
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
