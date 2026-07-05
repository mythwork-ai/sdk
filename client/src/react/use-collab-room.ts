// @mythwork/sdk/react — the per-(project, name) collab room hook. Owns the
// local Y.Doc + Awareness + WebsocketProvider lifecycle so apps don't construct
// any of those directly. Ported from @orbitcode/collab/react: the ONLY platform
// couplings that change are (1) room provisioning — `sdk.collab.openRoom()`
// instead of the legacy `openRoom(project)` shim — and (2) where the pid/client
// come from (`useProject()` + `useMythwork()` instead of `useProjectHandle()`).
// The Y.Doc / Awareness / WebsocketProvider / `?jt=` token wiring is identical
// to the code orbit-collab already runs in production.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { MythworkClient } from '../client'
import { useMythwork } from './platform'
import { useProject } from './project'

export type CollabConnectionStatus = 'disconnected' | 'connecting' | 'connected'
export type RoomScope = 'project' | 'app'

export interface UseCollabRoomOpts {
  name: string
  scope?: RoomScope
  /** Skip the websocket provider — useful for tests / offline-only flows. */
  noWebsocket?: boolean
  projectName?: string
  /**
   * Per-instance cache key. Without it, all `useCollabRoom` calls with the same
   * (client, pid, name, scope) share one Y.Doc + Awareness — correct for a
   * single app, wrong when a test renders two app instances side by side to
   * simulate two browsers. Pass a unique id to opt into per-mount Y.Docs that
   * still sync via the WebsocketProvider.
   */
  instanceId?: string
  /**
   * LOCAL-FIRST: do not provision or connect a server room. Bind a local Y.Doc
   * with ZERO network (no `collab.openRoom`, no WebSocket), keyed by a stable
   * local handle. Implies (and supersedes) `noWebsocket`.
   */
  local?: boolean
}

export interface CollaboratorInfo {
  clientId: number
  name: string
  color: string
  currentFile: string
  viewingSha: string | null
  isLocal: boolean
  picture: string | null
  email: string | null
}

interface AwarenessUserState {
  name?: string
  color?: string
  currentFile?: string
  viewingSha?: string | null
  picture?: string | null
  email?: string | null
}

export interface CollabRoomHandle {
  doc: Y.Doc | null
  awareness: Awareness | null
  collaborators: CollaboratorInfo[]
  status: CollabConnectionStatus
  syncing: boolean
  roomId: string | null
  serverUrl: string | null
  error: Error | null
  setAwareness: (field: string, value: unknown) => void
}

interface SharedRoom {
  doc: Y.Doc
  awareness: Awareness
  provider: WebsocketProvider | null
  roomId: string
  serverUrl: string
  refcount: number
  status: CollabConnectionStatus
  syncing: boolean
  statusListeners: Set<(s: CollabConnectionStatus) => void>
  syncListeners: Set<(s: boolean) => void>
}

// Per-client room caches: each MythworkClient gets its own (key → room) map, so
// two providers wired to two clients (two simulated browsers) never alias one
// Y.Doc. WeakMap keys release with the client; `liveRooms` is the strong-ref
// side list used only to tear rooms down in `_resetCollabForTests`.
const roomsByClient = new WeakMap<MythworkClient, Map<string, Promise<SharedRoom>>>()
const liveRooms = new Set<SharedRoom>()

function cacheFor(client: MythworkClient): Map<string, Promise<SharedRoom>> {
  let m = roomsByClient.get(client)
  if (!m) {
    m = new Map()
    roomsByClient.set(client, m)
  }
  return m
}

function roomKey(pid: string, name: string, scope: RoomScope, instanceId?: string): string {
  return instanceId ? `${pid}:${scope}:${name}#${instanceId}` : `${pid}:${scope}:${name}`
}

// Test seam — overridable WebsocketProvider constructor so tests don't open real
// WebSockets. `_setProviderFactoryForTests` injects a fake; `_resetCollabForTests`
// clears caches + restores the real factory between tests.
type ProviderFactory = (
  serverUrl: string,
  roomId: string,
  doc: Y.Doc,
  opts: { awareness: Awareness; joinToken?: string },
) => WebsocketProvider

const DEFAULT_PROVIDER_FACTORY: ProviderFactory = (serverUrl, roomId, doc, opts) =>
  // A server room carries a signed join token; pass it as a y-websocket `params`
  // entry so the provider appends `?jt=<token>` and the collab server verifies
  // the HMAC on connect. Local-first rooms have no token → no params.
  new WebsocketProvider(serverUrl, roomId, doc, {
    awareness: opts.awareness,
    ...(opts.joinToken ? { params: { jt: opts.joinToken } } : {}),
  })

let providerFactory: ProviderFactory = DEFAULT_PROVIDER_FACTORY

export function _setProviderFactoryForTests(f: ProviderFactory): void {
  providerFactory = f
}

export function _resetCollabForTests(): void {
  for (const room of liveRooms) {
    room.provider?.destroy()
    room.awareness.destroy()
    room.doc.destroy()
  }
  liveRooms.clear()
  devRelayRooms.clear()
  providerFactory = DEFAULT_PROVIDER_FACTORY
}

// ── dev collab relay ──────────────────────────────────────────────────────────
//
// An in-memory Y bridge so two `connect({ dev: true })` clients converge with NO
// real WebSocket server. Docs that join the same roomId (the dev host's
// `collab.openRoom` returns a shared `dev:<pid>:...` id) exchange Y updates — the
// same data-plane behavior y-websocket + the collab server give in production.
// Install once in dev/test (`installDevCollabRelay()`) before mounting collab
// hooks; it stays out of prod bundles unless imported.

const DEV_RELAY_ORIGIN = Symbol('mythwork-dev-relay')

interface DevRelayRoom {
  docs: Set<Y.Doc>
  awarenesses: Set<Awareness>
}
const devRelayRooms = new Map<string, DevRelayRoom>()

/**
 * A {@link ProviderFactory} that bridges everything sharing a roomId in memory —
 * BOTH the Y.Doc data plane AND Awareness presence — so two `connect({ dev:true })`
 * peers behave like they're on one real WebSocket room. Awareness matters as much
 * as doc data: editor apps derive "who else is here" (collaborator lists,
 * has-opponent gating, lobby discovery) from awareness, which y-websocket syncs in
 * production and this relay must mirror.
 */
export const devCollabRelayFactory: ProviderFactory = (_serverUrl, roomId, doc, opts) => {
  let room = devRelayRooms.get(roomId)
  if (!room) {
    room = { docs: new Set(), awarenesses: new Set() }
    devRelayRooms.set(roomId, room)
  }
  const { docs, awarenesses } = room
  const awareness = opts.awareness

  // Sync existing doc + awareness state into the newcomer and vice versa.
  for (const peer of docs) {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
  }
  for (const peerAw of awarenesses) {
    const clients = [...peerAw.getStates().keys()]
    if (clients.length > 0) {
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peerAw, clients), DEV_RELAY_ORIGIN)
    }
  }
  docs.add(doc)
  awarenesses.add(awareness)

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === DEV_RELAY_ORIGIN) return
    for (const peer of docs) if (peer !== doc) Y.applyUpdate(peer, update, DEV_RELAY_ORIGIN)
  }
  doc.on('update', onUpdate)

  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === DEV_RELAY_ORIGIN) return
    const changed = [...added, ...updated, ...removed]
    if (changed.length === 0) return
    const update = encodeAwarenessUpdate(awareness, changed)
    for (const peerAw of awarenesses) {
      if (peerAw !== awareness) applyAwarenessUpdate(peerAw, update, DEV_RELAY_ORIGIN)
    }
  }
  awareness.on('update', onAwareness)

  const statusCbs = new Set<(e: { status: CollabConnectionStatus }) => void>()
  const syncCbs = new Set<(s: boolean) => void>()
  // Announce connected + synced on the next microtask, like a real provider.
  queueMicrotask(() => {
    for (const cb of statusCbs) cb({ status: 'connected' })
    for (const cb of syncCbs) cb(true)
  })
  return {
    awareness,
    on(ev: string, cb: (...a: never[]) => void) {
      if (ev === 'status') statusCbs.add(cb as (e: { status: CollabConnectionStatus }) => void)
      if (ev === 'sync') syncCbs.add(cb as (s: boolean) => void)
    },
    off() {},
    connect() {},
    connectBc() {},
    disconnect() {},
    destroy() {
      doc.off('update', onUpdate)
      awareness.off('update', onAwareness)
      docs.delete(doc)
      awarenesses.delete(awareness)
      // Tell remaining peers this client's presence is gone (tab-close semantics).
      removeAwarenessStates(awareness, [awareness.clientID], DEV_RELAY_ORIGIN)
      for (const peerAw of awarenesses) {
        applyAwarenessUpdate(
          peerAw,
          encodeAwarenessUpdate(awareness, [awareness.clientID]),
          DEV_RELAY_ORIGIN,
        )
      }
    },
  } as unknown as WebsocketProvider
}

/**
 * Route collab rooms through the in-memory {@link devCollabRelayFactory} instead
 * of a real WebSocket. Call once in dev/test (before mounting collab hooks) so
 * `connect({ dev: true })` peers sharing a room converge with no server.
 */
export function installDevCollabRelay(): void {
  providerFactory = devCollabRelayFactory
}

async function acquireRoom(
  client: MythworkClient,
  pid: string,
  opts: UseCollabRoomOpts,
): Promise<SharedRoom> {
  const scope: RoomScope = opts.scope ?? 'project'
  const cache = cacheFor(client)
  const key = roomKey(pid, opts.name, scope, opts.instanceId)
  const existing = cache.get(key)
  if (existing) {
    const room = await existing
    room.refcount++
    return room
  }
  const pending = (async (): Promise<SharedRoom> => {
    const localOnly = opts.local === true
    const localDescriptor = {
      roomId: `local:${scope}:${opts.name}`,
      serverUrl: '',
      joinToken: undefined as string | undefined,
    }
    // Collab is an ENHANCEMENT, not a hard dependency: if provisioning the
    // server room fails (collab control plane down/cold), degrade to a local
    // in-memory Y.Doc (no WebSocket) instead of leaving `doc: null` forever —
    // which blanks the editor. A later mount re-attempts the server room.
    // (No IndexedDB persistence yet — see the package README — so the degraded
    // doc is in-memory only; orbit-collab additionally binds IDB here.)
    let degradedToLocal = false
    const { roomId, serverUrl, joinToken } = localOnly
      ? localDescriptor
      : await client.collab
          .openRoom({ pid, name: opts.name, scope, projectName: opts.projectName })
          .catch((e: Error) => {
            degradedToLocal = true
            console.warn(
              `[mythwork/sdk] collab.openRoom failed for ${scope}:${opts.name} — degrading to a local doc (no WS):`,
              e,
            )
            return localDescriptor
          })
    // `degradedToLocal` only catches a REJECTED openRoom call. An unassociated
    // project's bridge handler resolves cleanly with the local descriptor
    // itself (roomId `local:<scope>:<name>`, serverUrl '') — the room
    // genuinely doesn't exist yet, not a transient failure — so treat a
    // resolved-but-serverless result the same as a rejection: no websocket.
    // (joinToken is legitimately absent for the dev-host relay, which uses
    // its own in-memory bridge with no HMAC — only serverUrl signals "local".)
    const connectWebsocket = !localOnly && !degradedToLocal && !opts.noWebsocket && serverUrl !== ''
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const room: SharedRoom = {
      doc,
      awareness,
      provider: null,
      roomId,
      serverUrl,
      refcount: 1,
      status: 'disconnected',
      syncing: connectWebsocket,
      statusListeners: new Set(),
      syncListeners: new Set(),
    }
    if (connectWebsocket) {
      const provider = providerFactory(serverUrl, roomId, doc, { awareness, joinToken })
      room.provider = provider
      provider.on('status', (e: { status: CollabConnectionStatus }) => {
        room.status = e.status
        for (const l of room.statusListeners) l(e.status)
      })
      provider.on('sync', (synced: boolean) => {
        room.syncing = !synced
        for (const l of room.syncListeners) l(!synced)
      })
    }
    liveRooms.add(room)
    return room
  })()
  // A rejected provisioning must not poison the cache: drop the entry so a
  // later mount can retry instead of re-awaiting the same failure forever.
  // With the degrade-to-local path above this is defensive (provisioning no
  // longer rejects on a control-plane failure) — it guards any other throw.
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
  cache.set(key, pending)
  return pending
}

// Synchronous on the resolved SharedRoom: callers always hold one (either as
// `acquired` from a prior acquire, or as the `r` parameter in the cancelled
// branch of `.then(r => ...)`). Decrementing refcount + cache.delete in the
// same task as the cleanup closes the use-after-destroy race — an unmount
// followed by a remount with the same key in the same commit would otherwise
// queue this work as a microtask, run it AFTER the remount's `await existing`
// continuation, and hand the new mount a destroyed Y.Doc / Awareness.
function releaseRoom(client: MythworkClient, key: string, room: SharedRoom): void {
  const cache = roomsByClient.get(client)
  if (!cache) return
  room.refcount--
  if (room.refcount > 0) return
  cache.delete(key)
  liveRooms.delete(room)
  room.provider?.destroy()
  room.awareness.destroy()
  room.doc.destroy()
}

const NOOP_SET_AWARENESS = (_field: string, _value: unknown): void => {}

export function useCollabRoom(
  name: string,
  opts?: Omit<UseCollabRoomOpts, 'name'>,
): CollabRoomHandle
export function useCollabRoom(opts: UseCollabRoomOpts): CollabRoomHandle
export function useCollabRoom(
  arg0: string | UseCollabRoomOpts,
  arg1?: Omit<UseCollabRoomOpts, 'name'>,
): CollabRoomHandle {
  const opts: UseCollabRoomOpts = typeof arg0 === 'string' ? { name: arg0, ...(arg1 ?? {}) } : arg0
  const { sdk } = useMythwork()
  const { pid } = useProject()
  const [room, setRoom] = useState<SharedRoom | null>(null)
  const [status, setStatus] = useState<CollabConnectionStatus>('disconnected')
  const [syncing, setSyncing] = useState(true)
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [error, setError] = useState<Error | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  // biome-ignore lint/correctness/useExhaustiveDependencies: opts.* are read live via optsRef.current inside the effect; listed here only to re-acquire the room when its identity params change.
  useEffect(() => {
    if (!sdk || !pid) return
    const scope: RoomScope = optsRef.current.scope ?? 'project'
    let cancelled = false
    let acquired: SharedRoom | null = null
    const key = roomKey(pid, optsRef.current.name, scope, optsRef.current.instanceId)
    const onStatus = (s: CollabConnectionStatus): void => setStatus(s)
    const onSync = (s: boolean): void => setSyncing(s)

    let awarenessTarget: Awareness | null = null
    const onAwarenessChange = (): void => {
      if (!awarenessTarget) return
      const users: CollaboratorInfo[] = []
      const selfClientId = awarenessTarget.clientID
      awarenessTarget.getStates().forEach((state, clientId) => {
        const user = (state as Record<string, unknown>).user as AwarenessUserState | undefined
        if (!user) return
        users.push({
          clientId,
          name: user.name ?? '',
          color: user.color ?? '#999',
          currentFile: user.currentFile ?? '',
          viewingSha: user.viewingSha ?? null,
          isLocal: clientId === selfClientId,
          picture: user.picture ?? null,
          email: user.email ?? null,
        })
      })
      setCollaborators(users)
    }

    acquireRoom(sdk, pid, optsRef.current)
      .then(r => {
        if (cancelled) {
          releaseRoom(sdk, key, r)
          return
        }
        acquired = r
        r.statusListeners.add(onStatus)
        r.syncListeners.add(onSync)
        awarenessTarget = r.awareness
        r.awareness.on('change', onAwarenessChange)
        onAwarenessChange()
        setRoom(r)
        setStatus(r.status)
        setSyncing(r.syncing)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e)
      })

    return () => {
      cancelled = true
      if (acquired) {
        acquired.statusListeners.delete(onStatus)
        acquired.syncListeners.delete(onSync)
        if (awarenessTarget) awarenessTarget.off('change', onAwarenessChange)
        releaseRoom(sdk, key, acquired)
      }
    }
  }, [sdk, pid, opts.name, opts.scope, opts.instanceId, opts.local])

  const awareness = room?.awareness ?? null
  const setAwareness = useCallback(
    (field: string, value: unknown) => {
      awareness?.setLocalStateField(field, value)
    },
    [awareness],
  )

  return {
    doc: room?.doc ?? null,
    awareness,
    collaborators,
    status,
    syncing,
    roomId: room?.roomId ?? null,
    serverUrl: room?.serverUrl ?? null,
    error,
    setAwareness: awareness ? setAwareness : NOOP_SET_AWARENESS,
  }
}
