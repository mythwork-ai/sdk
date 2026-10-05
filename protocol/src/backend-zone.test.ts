import { describe, expect, it } from 'vitest'
import { backendZone } from './backend-zone'

describe('backendZone', () => {
  it('serves myth.work pages from mythwork.ai', () => {
    expect(backendZone('myth.work')).toBe('mythwork.ai')
  })

  it('keeps every other zone on itself', () => {
    expect(backendZone('mythwork.ai')).toBe('mythwork.ai')
    expect(backendZone('llama.space')).toBe('llama.space')
    expect(backendZone('orbitcode.ai')).toBe('orbitcode.ai')
  })
})
