// Dev host integration tests for the agent.* stub (AI-SDK Layer 3 PR-1).
// Drives a REAL MythworkClient over the dev host, verifying:
//   - create → send → ordered agent.event pushes with monotonic seq → turn-done
//   - file-edit tool call mutates the shared dev project store → fs.changed fires
//   - signed-out gated result (sign_in_required)
//   - turn_in_progress gating (concurrent sends)
//   - custom tools declaration → custom_tools_unsupported
//   - agent.stop mid-turn → turn-done(stopped)
//   - agent.state returns session transcript
//   - agent.dispose tears down the session

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MythworkClient } from '../client'
import type { EventPayload } from '@mythwork/protocol'
import { _resetDevHostForTests, createDevHost } from './host'

// The subscribe handler receives EventPayload<'agent.event'> (without the
// `type` field — the push router strips it before dispatch). Use AgentPayload
// for handler and array types; the seq/sessionId/event fields cover all assertions.
type AgentPayload = EventPayload<'agent.event'>

const tick = () => new Promise<void>(r => setTimeout(r, 0))

const SIGNED_IN_USER = {
  kind: 'pseudonymous' as const,
  userId: 'test-user',
  displayName: 'Test User',
  access: { approved: true, approvedAt: null, acceptedAt: null, inviteCodeHash: null },
}

beforeEach(() => _resetDevHostForTests())

describe('agent.create', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('returns a sessionId when signed in', async () => {
    const result = await sdk.agent.create({})
    expect(result).toMatchObject({ sessionId: expect.any(String) })
  })

  it('signed-out → sign_in_required (gated-result, never throws)', async () => {
    const anonSdk = new MythworkClient(createDevHost())
    try {
      const result = await anonSdk.agent.create({})
      expect(result).toEqual({ ok: false, reason: 'sign_in_required' })
    } finally {
      anonSdk.port.close()
    }
  })

  it('custom tools declaration → custom_tools_unsupported', async () => {
    const result = await sdk.agent.create({ tools: [{ name: 'my_tool', description: 'custom' }] })
    expect(result).toEqual({ ok: false, reason: 'custom_tools_unsupported' })
  })
})

describe('agent.send — scripted event script', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('resolves fast-ack { turnId } without waiting for events', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const result = await sdk.agent.send({ sessionId, text: 'hello' })
    expect(result).toMatchObject({ turnId: expect.any(String) })
  })

  it('pushes ordered agent.event messages with monotonic seq, ending in turn-done(ok)', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }

    const received: AgentPayload[] = []
    sdk.subscribe('agent.event', (payload: AgentPayload) => received.push(payload))

    const sendResult = (await sdk.agent.send({ sessionId, text: 'go' })) as { turnId: string }
    const { turnId } = sendResult

    // Wait for async event script to run
    await tick()
    await tick()

    expect(received.length).toBeGreaterThan(0)

    // Monotonic seq starting at 0
    for (let i = 0; i < received.length; i++) {
      expect(received[i]!.seq).toBe(i)
      expect(received[i]!.sessionId).toBe(sessionId)
    }

    // First event is turn-start with the correct turnId
    expect(received[0]!.event).toEqual({ kind: 'turn-start', turnId })

    // Last event is turn-done with status 'ok'
    const last = received.at(-1)!
    expect(last.event).toMatchObject({ kind: 'turn-done', turnId, status: 'ok' })

    // turn-done is the ONLY terminal signal — must be last
    const terminalIdx = received.findIndex(m => m.event.kind === 'turn-done')
    expect(terminalIdx).toBe(received.length - 1)
  })

  it('emits text-delta events before text-done', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const received: AgentPayload[] = []
    sdk.subscribe('agent.event', (p: AgentPayload) => received.push(p))

    await sdk.agent.send({ sessionId, text: 'hi' })
    await tick()
    await tick()

    const kinds = received.map(m => m.event.kind)
    const deltaIdx = kinds.indexOf('text-delta')
    const doneIdx = kinds.indexOf('text-done')
    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(doneIdx).toBeGreaterThan(deltaIdx)

    // text-done text must equal the concatenation of all deltas
    const deltas = received
      .filter(m => m.event.kind === 'text-delta')
      .map(m => (m.event as { kind: 'text-delta'; delta: string }).delta)
      .join('')
    const textDone = received.find(m => m.event.kind === 'text-done')!.event as {
      kind: 'text-done'
      text: string
    }
    expect(textDone.text).toBe(deltas)
  })

  it('includes a changes event before turn-done', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const received: AgentPayload[] = []
    sdk.subscribe('agent.event', (p: AgentPayload) => received.push(p))

    await sdk.agent.send({ sessionId, text: 'edit' })
    await tick()
    await tick()

    const changesEvent = received.find(m => m.event.kind === 'changes')
    expect(changesEvent).toBeDefined()
    const changesIdx = received.indexOf(changesEvent!)
    const turnDoneIdx = received.findIndex(m => m.event.kind === 'turn-done')
    expect(changesIdx).toBeLessThan(turnDoneIdx)
  })
})

describe('agent.send — file-edit turn with fs.changed', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('file-edit tool call mutates dev project store and fires fs.changed', async () => {
    // Create a project so the agent turn has a store to mutate.
    const { pid } = await sdk.project.create({ projectName: 'agent-test' })

    const fsChanges: Array<{ path: string; kind: string }> = []
    sdk.fs.onChanged(({ path, kind }) => fsChanges.push({ path, kind }))

    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const agentEvents: AgentPayload[] = []
    sdk.subscribe('agent.event', (p: AgentPayload) => agentEvents.push(p))

    await sdk.agent.send({ sessionId, text: 'edit a file' })
    await tick()
    await tick()

    // fs.changed should have fired for agent-edit.txt
    expect(fsChanges.some(c => c.path === 'agent-edit.txt')).toBe(true)

    // The agent event sequence should include tool-start and tool-result
    const toolStart = agentEvents.find(m => m.event.kind === 'tool-start')
    const toolResult = agentEvents.find(m => m.event.kind === 'tool-result')
    expect(toolStart).toBeDefined()
    expect(toolResult).toBeDefined()

    // tool-start comes before tool-result
    expect(agentEvents.indexOf(toolStart!)).toBeLessThan(agentEvents.indexOf(toolResult!))

    // changes event lists the edited file
    const changesEvent = agentEvents.find(m => m.event.kind === 'changes')
    expect(changesEvent).toBeDefined()
    const ce = changesEvent!.event as { kind: 'changes'; files: string[] }
    expect(ce.files).toContain('agent-edit.txt')

    // The file is readable via fs.read
    const bytes = await sdk.fs.read({ pid, path: 'agent-edit.txt' })
    expect(bytes.byteLength).toBeGreaterThan(0)
  })
})

describe('agent.send — turn_in_progress gating', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('concurrent sends: second returns turn_in_progress', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }

    // Fire both sends before awaiting either — both messages are queued
    const p1 = sdk.agent.send({ sessionId, text: 'first' })
    const p2 = sdk.agent.send({ sessionId, text: 'second' })

    const [r1, r2] = await Promise.all([p1, p2])

    // First succeeds with a turnId
    expect(r1).toMatchObject({ turnId: expect.any(String) })
    // Second is rejected while turn is in progress
    expect(r2).toEqual({ ok: false, reason: 'turn_in_progress' })

    // Let events settle
    await tick()
    await tick()
  })
})

describe('agent.answer', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('returns { ok: true } for a known session', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const r = await sdk.agent.answer({ sessionId, questionId: 'q1', answers: ['yes'] })
    expect(r).toEqual({ ok: true })
  })

  it('unknown session → rejects (dev host throws)', async () => {
    await expect(
      sdk.agent.answer({ sessionId: 'nope', questionId: 'q1', answers: ['ok'] }),
    ).rejects.toThrow()
  })

  it('signed-out → gated-result', async () => {
    const anonSdk = new MythworkClient(createDevHost())
    try {
      const r = await anonSdk.agent.answer({
        sessionId: 'any',
        questionId: 'q1',
        answers: ['ok'],
      })
      expect(r).toEqual({ ok: false, reason: 'sign_in_required' })
    } finally {
      anonSdk.port.close()
    }
  })
})

describe('agent.stop', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('stop during active turn emits turn-done(stopped)', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const received: AgentPayload[] = []
    sdk.subscribe('agent.event', (p: AgentPayload) => received.push(p))

    // Start a turn and immediately stop it before events fire
    const sendPromise = sdk.agent.send({ sessionId, text: 'start' })
    await sdk.agent.stop({ sessionId })

    await sendPromise
    await tick()
    await tick()

    // Should have received turn-done with status 'stopped'
    const last = received.at(-1)
    expect(last?.event).toMatchObject({ kind: 'turn-done', status: 'stopped' })
  })

  it('signed-out → gated-result', async () => {
    const anonSdk = new MythworkClient(createDevHost())
    try {
      const r = await anonSdk.agent.stop({ sessionId: 'any' })
      expect(r).toEqual({ ok: false, reason: 'sign_in_required' })
    } finally {
      anonSdk.port.close()
    }
  })
})

describe('agent.state', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('idle session has status "idle" and empty transcript', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const state = (await sdk.agent.state({ sessionId })) as {
      status: string
      transcript: unknown[]
    }
    expect(state.status).toBe('idle')
    expect(state.transcript).toEqual([])
  })

  it('transcript grows after sends complete', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    await sdk.agent.send({ sessionId, text: 'hello' })
    await tick()
    await tick()

    const state = (await sdk.agent.state({ sessionId })) as {
      status: string
      transcript: unknown[]
    }
    expect(state.transcript.length).toBeGreaterThan(0)
    // User message appears in transcript
    const userMsg = (state.transcript as Array<{ role: string; content: string }>).find(
      m => m.role === 'user',
    )
    expect(userMsg?.content).toBe('hello')
  })

  it('signed-out → gated-result', async () => {
    const anonSdk = new MythworkClient(createDevHost())
    try {
      const r = await anonSdk.agent.state({ sessionId: 'any' })
      expect(r).toEqual({ ok: false, reason: 'sign_in_required' })
    } finally {
      anonSdk.port.close()
    }
  })
})

describe('agent.dispose', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost({ user: SIGNED_IN_USER }))
  })
  afterEach(() => sdk.port.close())

  it('dispose removes the session', async () => {
    const { sessionId } = (await sdk.agent.create({})) as { sessionId: string }
    const r = await sdk.agent.dispose({ sessionId })
    expect(r).toEqual({ ok: true })

    // After dispose, agent.state throws (session not found)
    await expect(sdk.agent.state({ sessionId })).rejects.toThrow()
  })

  it('signed-out → gated-result', async () => {
    const anonSdk = new MythworkClient(createDevHost())
    try {
      const r = await anonSdk.agent.dispose({ sessionId: 'any' })
      expect(r).toEqual({ ok: false, reason: 'sign_in_required' })
    } finally {
      anonSdk.port.close()
    }
  })
})
