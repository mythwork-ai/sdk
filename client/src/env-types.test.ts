// Type-level + runtime guards for the env-store protocol additions.
// (Protocol is constants-only with no test runner, so the tests live in the
// client suite — same as prompts-types.test.ts.)
//
// Spec: env.list → names only (never values); env.open → host-owned editor
// popup that resolves on close. No env.get in v1.
import { type MethodMap } from '@mythwork/protocol'
import { describe, expect, it } from 'vitest'

describe('env.list method map', () => {
  it('has a MethodMap entry: no client params, result is { names: string[] }', () => {
    const params: MethodMap['env.list']['params'] = {}
    const result: MethodMap['env.list']['result'] = { names: ['MY_SECRET', 'PROMPT_GAIAD_VOICE'] }
    expect([params, result]).toHaveLength(2)
  })
})

describe('env.open method map', () => {
  it('has a MethodMap entry: no client params, result is { ok: boolean }', () => {
    const params: MethodMap['env.open']['params'] = {}
    const saved: MethodMap['env.open']['result'] = { ok: true }
    const cancelled: MethodMap['env.open']['result'] = { ok: false }
    expect([params, saved, cancelled]).toHaveLength(3)
  })
})
