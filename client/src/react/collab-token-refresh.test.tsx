// @vitest-environment happy-dom
//
// Join-token reconnect wiring for the SDK collab room
// (`sdk/client/src/react/use-collab-room.ts` — provider construction + the
// `wireJoinTokenRefresh` call site).
//
// The join token lives 120s and the collab server re-authorizes on EVERY
// reconnect, so a room that keeps its construction-time token turns any
// disconnect longer than the TTL into a guaranteed rejection, retried forever.
// These drive the real hook — no injected provider factory, so the module's own
// `DEFAULT_PROVIDER_FACTORY` runs with `y-websocket` mocked at the module
// boundary — and assert on what that construction actually passes and what the
// re-provision path actually does to the live provider.
//
// The stub models y-websocket's real surface: a mutable `params` re-encoded into
// the URL on every reconnect, the `shouldConnect` retry flag (:318), and
// `bcconnected`, which `disconnect()` clears via `disconnectBc()` (:499-505).
// Cross-tab sync needs no server, so a server outage must never take
// BroadcastChannel down with it.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import {
  MAX_REFRESH_FAILURES,
  RECONNECT_BACKOFF_JITTER,
  RECONNECT_MAX_BACKOFF_MS,
} from '@mythwork/protocol/collab-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ProviderOpts {
  awareness?: unknown
  params?: Record<string, string>
  maxBackoffTime?: number
  disableBc?: boolean
}

/** The stub's observable surface (see the mock factory below). */
interface FakeProvider {
  opts: ProviderOpts
  params: Record<string, string>
  shouldConnect: boolean
  bcconnected: boolean
  connectCalls: number
  disconnectCalls: number
  emit(event: string, ...args: unknown[]): void
}

// The factory is hoisted above every top-level binding in this file, so the stub
// class is DEFINED INSIDE it and its instances read back off the mocked export.
vi.mock('y-websocket', () => {
  class FakeWebsocketProvider {
    static instances: FakeWebsocketProvider[] = []
    params: Record<string, string>
    /** y-websocket's own "keep retrying the socket?" flag (y-websocket.js:318). */
    shouldConnect = true
    /** y-websocket's BroadcastChannel subscription flag (:443 / :493-496). */
    bcconnected = true
    connectCalls = 0
    disconnectCalls = 0
    destroyed = false
    awareness: unknown
    private listeners = new Map<string, Set<(...args: never[]) => void>>()

    constructor(
      public serverUrl: string,
      public room: string,
      public doc: unknown,
      public opts: ProviderOpts,
    ) {
      this.awareness = opts.awareness
      this.params = opts.params ?? {}
      FakeWebsocketProvider.instances.push(this)
    }
    on(event: string, cb: (...args: never[]) => void): void {
      let set = this.listeners.get(event)
      if (!set) {
        set = new Set()
        this.listeners.set(event, set)
      }
      set.add(cb)
    }
    off(event: string, cb: (...args: never[]) => void): void {
      this.listeners.get(event)?.delete(cb)
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) {
        ;(cb as (...a: unknown[]) => void)(...args)
      }
    }
    connect(): void {
      this.connectCalls++
      this.shouldConnect = true
      this.bcconnected = true
    }
    /** Mirrors y-websocket disconnect() (:499-505): disconnectBc() FIRST. */
    disconnect(): void {
      this.disconnectCalls++
      this.bcconnected = false
      this.shouldConnect = false
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return { WebsocketProvider: FakeWebsocketProvider }
})

import { WebsocketProvider } from 'y-websocket'
import { MythworkClient } from '../client'
import {
  _resetCollabForTests,
  MythworkProjectProvider,
  MythworkProvider,
  useCollabRoom,
} from './index'

const mockedProviderClass = WebsocketProvider as unknown as { instances: FakeProvider[] }
const providerInstances = (): FakeProvider[] => mockedProviderClass.instances

const ROOM_ID = 'room-sdk-editor'
const PID = 'p-sdk-jt'

/** A `b64url({rid,exp,w}).sig` join token — the shape `readJoinTokenExp` parses
 * (workers/api/src/common/room-id.ts). */
function makeJoinToken(expMs: number, tag = 'a'): string {
  const body = btoa(JSON.stringify({ rid: ROOM_ID, exp: expMs, w: true }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${body}.sig-${tag}`
}

type OpenRoomReply = { result: unknown } | { error: string }

function descriptor(joinToken: string, roomId = ROOM_ID): OpenRoomReply {
  return { result: { roomId, serverUrl: 'ws://collab.test', joinToken } }
}

/** A client whose host answers `collab.openRoom` differently per call, so a test
 * can hand out a stale token first and then fail / rotate / renew. */
function makeClient(reply: (call: number) => OpenRoomReply): {
  client: MythworkClient
  calls: () => number
} {
  let calls = 0
  const chan = new MessageChannel()
  chan.port2.start()
  chan.port2.onmessage = (e: MessageEvent) => {
    const { id, method, args } = e.data as {
      id: string
      method: string
      args: Record<string, unknown>
    }
    switch (method) {
      case 'project.open':
      case 'project.create':
        chan.port2.postMessage({ id, result: { pid: args.pid ?? PID, role: 'leader' } })
        return
      case 'project.close':
        chan.port2.postMessage({ id, result: { ok: true } })
        return
      case 'kernel.getUser':
        chan.port2.postMessage({ id, result: { kind: 'anonymous', userId: 'anon' } })
        return
      case 'collab.openRoom': {
        calls++
        chan.port2.postMessage({ id, ...reply(calls) })
        return
      }
      default:
        chan.port2.postMessage({ id, result: {} })
    }
  }
  return { client: new MythworkClient(chan.port1), calls: () => calls }
}

function Probe(): React.JSX.Element {
  const { doc, status } = useCollabRoom({ name: 'editor' })
  return <div data-testid="probe">{doc ? status : 'loading'}</div>
}

async function mountRoom(client: MythworkClient): Promise<{ text: () => string | undefined }> {
  const api = render(
    <MythworkProvider connect={() => Promise.resolve(client)}>
      <MythworkProjectProvider pid={PID}>
        <Probe />
      </MythworkProjectProvider>
    </MythworkProvider>,
  )
  const text = (): string | undefined => api.queryByTestId('probe')?.textContent ?? undefined
  await waitFor(() => {
    expect(providerInstances()).toHaveLength(1)
  })
  await waitFor(() => {
    expect(text()).not.toBe('loading')
  })
  return { text }
}

/** A REAL macrotask turn — the host is a MessageChannel, whose delivery no
 * amount of microtask flushing (or fake-timer advancing) will produce. */
function realYield(): Promise<void> {
  return new Promise(resolve => {
    const c = new MessageChannel()
    c.port1.onmessage = () => resolve()
    c.port1.start()
    c.port2.postMessage(0)
  })
}

beforeEach(() => {
  mockedProviderClass.instances = []
  _resetCollabForTests()
})

afterEach(() => {
  cleanup()
  _resetCollabForTests()
  vi.useRealTimers()
})

describe('@mythwork/sdk/react join-token refresh', () => {
  it('re-provisions the room and swaps the fresh token into the live provider on a stale close', async () => {
    const stale = makeJoinToken(Date.now() + 1_000, 'stale')
    const fresh = makeJoinToken(Date.now() + 600_000, 'fresh')
    const { client, calls } = makeClient(call => descriptor(call === 1 ? stale : fresh))
    await mountRoom(client)
    const provider = providerInstances()[0]!
    expect(provider.params.jt, 'constructed with the provisioned token').toBe(stale)

    // The socket drops while the token is inside the 10s staleness window.
    await act(async () => {
      provider.emit('connection-close', {}, provider)
    })
    await waitFor(() => {
      expect(provider.params.jt).toBe(fresh)
    })
    // The site's OWN re-provision path ran (a second collab.openRoom) and the
    // provider was reconnected so y-websocket re-encodes the new token.
    expect(calls()).toBe(2)
    expect(provider.connectCalls).toBe(1)
    expect(provider.disconnectCalls, 'never disconnect() — it kills cross-tab sync').toBe(0)
    expect(provider.bcconnected).toBe(true)
  })

  it('leaves a still-valid token alone on an ordinary close', async () => {
    const good = makeJoinToken(Date.now() + 600_000, 'good')
    const { client, calls } = makeClient(() => descriptor(good))
    await mountRoom(client)
    const provider = providerInstances()[0]!

    await act(async () => {
      provider.emit('connection-close', {}, provider)
      await realYield()
    })
    expect(calls(), "a blip with a live token is y-websocket's own business").toBe(1)
    expect(provider.params.jt).toBe(good)
    expect(provider.shouldConnect, 'y-websocket keeps retrying on its own').toBe(true)
  })

  it('constructs the provider with a jittered ~30s reconnect ceiling and cross-tab sync ON', async () => {
    const { client } = makeClient(() => descriptor(makeJoinToken(Date.now() + 600_000)))
    await mountRoom(client)
    const { opts } = providerInstances()[0]!
    const ceiling = opts.maxBackoffTime as number

    expect(typeof ceiling).toBe('number')
    expect(ceiling).toBeGreaterThanOrEqual(
      RECONNECT_MAX_BACKOFF_MS * (1 - RECONNECT_BACKOFF_JITTER),
    )
    expect(ceiling).toBeLessThanOrEqual(RECONNECT_MAX_BACKOFF_MS * (1 + RECONNECT_BACKOFF_JITTER))
    expect(ceiling, "must be far above y-websocket's own 2_500 ceiling").toBeGreaterThan(2_500)
    // Cross-tab sync is genuinely on — which is what makes the give-up test
    // below (BroadcastChannel survives an outage) a real assertion.
    expect(opts.disableBc, 'BroadcastChannel must be enabled for this site').toBeUndefined()
  })

  it('refuses a re-provision that returns a DIFFERENT roomId', async () => {
    // The token is about to be written into a provider already bound to ROOM_ID;
    // authorizing against another room is worse than not reconnecting.
    const stale = makeJoinToken(Date.now() + 1_000, 'stale')
    const otherRoom = makeJoinToken(Date.now() + 600_000, 'other')
    const { client, calls } = makeClient(call =>
      call === 1 ? descriptor(stale) : descriptor(otherRoom, 'room-somewhere-else'),
    )
    await mountRoom(client)
    const provider = providerInstances()[0]!

    await act(async () => {
      provider.emit('connection-close', {}, provider)
      await realYield()
      await realYield()
      await realYield()
    })
    expect(calls(), 'the re-provision was attempted').toBeGreaterThanOrEqual(2)
    expect(provider.params.jt, 'a foreign room token must never be installed').toBe(stale)
    expect(provider.connectCalls).toBe(0)
  })

  it('reports give-up WITHOUT tearing down BroadcastChannel, and keeps retrying', async () => {
    // Two regressions in one: (1) give-up must not call provider.disconnect(),
    // which runs disconnectBc() and makes every other tab see this one vanish
    // for the whole outage; (2) give-up is a report, not a terminal state — a
    // later successful mint must still reconnect this client.
    const stale = makeJoinToken(Date.now() + 1_000, 'stale')
    const fresh = makeJoinToken(Date.now() + 3_600_000, 'fresh')
    const FAILURES = MAX_REFRESH_FAILURES + 2
    const { client, calls } = makeClient(call => {
      if (call === 1) return descriptor(stale)
      if (call <= FAILURES + 1) return { error: 'provision unavailable (api worker down)' }
      return descriptor(fresh)
    })
    const { text } = await mountRoom(client)
    const provider = providerInstances()[0]!

    // A live socket first, so the give-up is an observable transition.
    await act(async () => {
      provider.emit('status', { status: 'connected' })
    })
    expect(text()).toBe('connected')

    // Only setTimeout is faked: the host is a real MessageChannel and the
    // refresh awaits it, so Date / microtasks / message delivery stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      provider.emit('connection-close', {}, provider)
    })
    for (let i = 0; i < 60 && text() !== 'disconnected'; i++) {
      await act(async () => {
        await realYield()
        await vi.advanceTimersByTimeAsync(60_000)
      })
    }

    expect(text(), 'onGiveUp reports the room as disconnected').toBe('disconnected')
    expect(calls()).toBeGreaterThan(MAX_REFRESH_FAILURES)
    expect(provider.disconnectCalls, 'the helper must never call provider.disconnect()').toBe(0)
    expect(provider.bcconnected, 'cross-tab sync survives a server/mint outage').toBe(true)

    // The loop never stopped: minting starts working again and the client
    // reconnects on its own, with no remount and no user action.
    for (let i = 0; i < 60 && provider.params.jt !== fresh; i++) {
      await act(async () => {
        await realYield()
        await vi.advanceTimersByTimeAsync(60_000)
      })
    }
    expect(provider.params.jt, 'give-up is a report, not a terminal state').toBe(fresh)
    expect(provider.connectCalls).toBe(1)
    expect(provider.bcconnected).toBe(true)
  })
})
