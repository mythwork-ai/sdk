// Type-level + table-integrity guards for the prompt-presets protocol additions.
// (Protocol is constants-only with no test runner, so the tests live in the
// client suite — same as descriptors.test.ts.)
//
// Correction A (security): the preset's projectId is NOT a client-supplied field.
// It is derived host-side from the trusted current-project context, so neither
// AiOpts nor the ai.* wire params nor prompts.list carry a `projectId`.
import { API_METHOD_DESCRIPTORS, type AiOpts, type MethodMap } from '@mythwork/protocol'
import { describe, expect, it } from 'vitest'

describe('AiOpts system / systemPreset mutual exclusion', () => {
  it('accepts a bare system, a bare systemPreset, or neither', () => {
    const a: AiOpts = { system: 'You are…' }
    const b: AiOpts = { systemPreset: 'project_plan' }
    const c: AiOpts = { model: 'x' }
    expect([a, b, c]).toHaveLength(3)
  })

  it('rejects passing BOTH system and systemPreset at the type level', () => {
    // @ts-expect-error — system and systemPreset are mutually exclusive.
    const bad: AiOpts = { system: 'You are…', systemPreset: 'project_plan' }
    expect(bad).toBeTruthy()
  })
})

describe('prompts.list descriptor', () => {
  it('binds GET /prompts/:projectId with gated-result posture', () => {
    expect(API_METHOD_DESCRIPTORS['prompts.list']).toEqual({
      http: { verb: 'GET', path: '/prompts/:projectId' },
      auth: { signedOut: 'result', onError: 'result' },
    })
  })

  it('has a MethodMap entry: no client params, result is names | gated result', () => {
    const params: MethodMap['prompts.list']['params'] = {}
    const ok: MethodMap['prompts.list']['result'] = { names: ['project_plan'] }
    const gated: MethodMap['prompts.list']['result'] = { ok: false, reason: 'sign_in_required' }
    expect([params, ok, gated]).toHaveLength(3)
  })
})
