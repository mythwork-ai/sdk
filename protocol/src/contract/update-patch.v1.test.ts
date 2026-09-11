// What this suite can and cannot check. The patch body is a compile-time
// shape, so the assertion that matters is the @ts-expect-error line below:
// it FAILS THE TYPECHECK if the shape ever stops rejecting a server-managed
// name. The runtime expectations are the small remainder — that an empty
// patch and a null-valued member both type-check and survive as written.

import { describe, expect, it } from 'vitest'
import type { PatchBody } from './update-patch.v1'

type Task = { title: string; priority?: number }

describe('the patch body', () => {
  it('makes every declared field optional, so an empty patch type-checks', () => {
    const body: PatchBody<Task> = {}
    expect(Object.keys(body)).toEqual([])
  })

  it('admits null on a field, which is how a value is cleared', () => {
    const body: PatchBody<Task> = { priority: null }
    expect(body.priority).toBeNull()
  })

  it('refuses a server-managed name, exactly as a create does', () => {
    // @ts-expect-error created_at moves only when the server moves it
    const body: PatchBody<Task> = { created_at: '2026-03-01T09:00:00.000Z' }
    void body
  })
})
