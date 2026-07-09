import { describe, expect, it } from 'vitest'
import { zoneHost } from './zone'

describe('zoneHost', () => {
  it('strips sub-labels, keeping only the last two: explore.llama.space → llama.space', () => {
    expect(zoneHost('explore.llama.space')).toBe('llama.space')
  })

  it('keeps two-label hostname unchanged: explore.myth.work → myth.work', () => {
    expect(zoneHost('explore.myth.work')).toBe('myth.work')
  })

  it('deep sub-domain collapses to last two: build.staging.myth.work → myth.work', () => {
    expect(zoneHost('build.staging.myth.work')).toBe('myth.work')
  })

  it('localhost falls back to myth.work', () => {
    expect(zoneHost('localhost')).toBe('myth.work')
  })

  it('127.0.0.1 falls back to myth.work', () => {
    expect(zoneHost('127.0.0.1')).toBe('myth.work')
  })

  it('LAN IPv4 literal falls back to myth.work (phone testing dev server)', () => {
    expect(zoneHost('192.168.1.5')).toBe('myth.work')
    expect(zoneHost('10.0.0.8')).toBe('myth.work')
  })

  it('single-label host falls back to myth.work', () => {
    expect(zoneHost('myapp')).toBe('myth.work')
  })

  it('no-arg + no window (node env) falls back to myth.work', () => {
    // In the vitest node environment, `window` is undefined, so the fallback
    // kicks in and returns the production zone.
    expect(zoneHost()).toBe('myth.work')
  })
})
