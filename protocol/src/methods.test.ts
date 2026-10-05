import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AgentEvent } from './methods'

type ErrorEvent = Extract<AgentEvent, { kind: 'error' }>

describe('AgentEvent error reasons', () => {
  it('accepts app_not_found and still reads as a string', () => {
    const event: ErrorEvent = {
      kind: 'error',
      message: 'gone',
      fatal: false,
      reason: 'app_not_found',
    }
    expectTypeOf<'app_not_found'>().toMatchTypeOf<NonNullable<ErrorEvent['reason']>>()
    expectTypeOf<NonNullable<ErrorEvent['reason']>>().toMatchTypeOf<string>()
    const reason: string | undefined = event.reason
    expect(reason).toBe('app_not_found')
  })
})
