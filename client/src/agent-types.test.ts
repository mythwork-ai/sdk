// Type-level + descriptor guards for the agent.* protocol additions (AI-SDK Layer 3).
// Protocol is constants-only with no test runner, so type tests live in the client
// suite — same pattern as prompts-types.test.ts.

import type {
  AgentEvent,
  AgentEventPush,
  AgentGatedReason,
  AgentSessionOptions,
  AgentSessionStatus,
  GatedResult,
  MethodMap,
  MethodParams,
  MethodResult,
} from '@mythwork/protocol'
import { describe, expect, it } from 'vitest'

describe('GatedResult', () => {
  it('is { ok: false; reason: AgentGatedReason }', () => {
    const r: GatedResult = { ok: false, reason: 'sign_in_required' }
    expect(r.ok).toBe(false)
  })

  it('includes unknown_question (agent.answer id mismatch) as a valid reason', () => {
    const reasons: AgentGatedReason[] = [
      'sign_in_required',
      'turn_in_progress',
      'session_limit',
      'unknown_session',
      'unknown_question',
      'custom_tools_unsupported',
    ]
    const r: GatedResult = { ok: false, reason: 'unknown_question' }
    expect(reasons).toContain(r.reason)
  })

  it('rejects an unlisted reason at the type level', () => {
    // @ts-expect-error — reason must be an AgentGatedReason, not an arbitrary string
    const bad: GatedResult = { ok: false, reason: 'totally_made_up' }
    expect(bad).toBeTruthy()
  })
})

describe('AgentSessionOptions', () => {
  it('accepts all optional fields', () => {
    const full: AgentSessionOptions = {
      persona: 'gaiad',
      variant: 'concise',
      model: 'claude-opus-4-5',
      toolset: 'default',
      instructions: 'Be concise.',
      tools: [],
    }
    expect(full.persona).toBe('gaiad')
  })

  it('accepts empty options', () => {
    const empty: AgentSessionOptions = {}
    expect(empty).toEqual({})
  })
})

describe('AgentEvent union', () => {
  it('covers all required kinds', () => {
    const kinds: AgentEvent['kind'][] = [
      'turn-start',
      'cycle-start',
      'text-delta',
      'text-done',
      'tool-start',
      'tool-result',
      'question',
      'changes',
      'error',
      'turn-done',
      'usage',
      'tool-request',
    ]
    expect(kinds).toHaveLength(12)
  })

  it('turn-start carries turnId', () => {
    const e: AgentEvent = { kind: 'turn-start', turnId: 'turn-1' }
    if (e.kind === 'turn-start') {
      expect(e.turnId).toBe('turn-1')
    }
  })

  it('turn-done status is ok | stopped | error', () => {
    const e: AgentEvent = { kind: 'turn-done', turnId: 't1', status: 'ok' }
    if (e.kind === 'turn-done') {
      const s: 'ok' | 'stopped' | 'error' = e.status
      expect(s).toBe('ok')
    }
  })

  it('error carries fatal and optional reason', () => {
    const e: AgentEvent = {
      kind: 'error',
      message: 'out of credits',
      fatal: true,
      reason: 'credits',
    }
    if (e.kind === 'error') {
      expect(e.fatal).toBe(true)
      expect(e.reason).toBe('credits')
    }
  })

  it('tool-start detail is optional', () => {
    const e: AgentEvent = { kind: 'tool-start', toolCallId: 'tc1', tool: 'file_edit' }
    expect(e).toBeTruthy()
    const withDetail: AgentEvent = {
      kind: 'tool-start',
      toolCallId: 'tc1',
      tool: 'file_edit',
      detail: { path: 'src/index.ts' },
    }
    expect(withDetail).toBeTruthy()
  })
})

describe('AgentEventPush envelope', () => {
  it('has type, sessionId, seq, event fields', () => {
    const push: AgentEventPush = {
      type: 'agent.event',
      sessionId: 'sess-1',
      seq: 0,
      event: { kind: 'turn-start', turnId: 't1' },
    }
    expect(push.type).toBe('agent.event')
    expect(push.seq).toBe(0)
  })

  it('type is literal "agent.event"', () => {
    const bad: AgentEventPush = {
      // @ts-expect-error — type must be exactly 'agent.event'
      type: 'other',
      sessionId: 's',
      seq: 0,
      event: { kind: 'turn-start', turnId: 't' },
    }
    expect(bad).toBeTruthy()
  })
})

describe('MethodMap agent.* entries', () => {
  it('agent.create params match AgentSessionOptions', () => {
    const p: MethodParams<'agent.create'> = {}
    const withOpts: MethodParams<'agent.create'> = { persona: 'g', variant: 'c' }
    expect([p, withOpts]).toHaveLength(2)
  })

  it('agent.create result is sessionId or GatedResult', () => {
    const ok: MethodResult<'agent.create'> = { sessionId: 'sess-1' }
    const gated: MethodResult<'agent.create'> = { ok: false, reason: 'sign_in_required' }
    const toolsGated: MethodResult<'agent.create'> = {
      ok: false,
      reason: 'custom_tools_unsupported',
    }
    expect([ok, gated, toolsGated]).toHaveLength(3)
  })

  it('agent.send result includes turnId on success or GatedResult', () => {
    const ok: MethodResult<'agent.send'> = { turnId: 'turn-1' }
    const inProgress: MethodResult<'agent.send'> = { ok: false, reason: 'turn_in_progress' }
    expect([ok, inProgress]).toHaveLength(2)
  })

  it('agent.answer result is Ok or a GatedResult (incl. unknown_question)', () => {
    const ok: MethodResult<'agent.answer'> = { ok: true }
    const unknownQ: MethodResult<'agent.answer'> = { ok: false, reason: 'unknown_question' }
    expect([ok, unknownQ]).toHaveLength(2)
  })

  it('agent.state result has status (literal: idle | active) + transcript', () => {
    const idle: MethodResult<'agent.state'> = { status: 'idle', transcript: [] }
    const active: MethodResult<'agent.state'> = { status: 'active', transcript: [] }
    expect(idle).toMatchObject({ status: 'idle' })
    expect(active).toMatchObject({ status: 'active' })
  })

  it('agent.state status must be AgentSessionStatus literal', () => {
    const s: AgentSessionStatus = 'idle'
    expect(s).toBe('idle')
    // @ts-expect-error — status must be 'idle' or 'active', not arbitrary string
    const bad: MethodResult<'agent.state'> = { status: 'paused', transcript: [] }
    expect(bad).toBeTruthy()
  })

  it('all six methods exist in MethodMap', () => {
    const methods: (keyof MethodMap)[] = [
      'agent.create',
      'agent.send',
      'agent.answer',
      'agent.stop',
      'agent.state',
      'agent.dispose',
    ]
    expect(methods).toHaveLength(6)
  })
})
