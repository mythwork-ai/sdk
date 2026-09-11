// What this suite can and cannot check. The create body is a compile-time
// shape, so the assertions that matter are the @ts-expect-error lines
// below: each one FAILS THE TYPECHECK if the shape ever stops rejecting
// what it is supposed to reject.

import { describe, expect, it } from 'vitest'
import type { CreateBody } from './create-body.v1'

type Task = { title: string; priority?: number }

describe('the create body', () => {
  it('takes the declared fields', () => {
    const body: CreateBody<Task> = { title: 'Write the driver', priority: 3 }
    expect(body.title).toBe('Write the driver')
  })

  it('refuses a server-managed name — that is PROHIBITED_FIELD on the wire', () => {
    // @ts-expect-error `id` is the server's to stamp, never the client's to send
    const body: CreateBody<Task> = { title: 'Write the driver', id: 7 }
    void body
  })

  it('refuses null where a create has no null', () => {
    // @ts-expect-error only a patch may carry null, and only on an optional field
    const body: CreateBody<Task> = { title: null }
    void body
  })
})
