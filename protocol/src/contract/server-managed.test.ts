import { describe, expect, it } from 'vitest'
import {
  SERVER_MANAGED_ENTITIES,
  isServerManagedEntityName,
  isServerManagedFieldName,
} from './server-managed'

describe('the server-managed entity registry', () => {
  it('reserves entity id 1, so declared minting starts above it', () => {
    expect(isServerManagedEntityName('users')).toBe(true)
    expect(SERVER_MANAGED_ENTITIES.users.reservedEntityId).toBe(1)
  })

  it('reserves the filename a project extends it through', () => {
    expect(SERVER_MANAGED_ENTITIES.users.reservedFileName).toBe('entities/users.jsonc')
  })

  it('withholds create and delete, so a project cannot invent or remove people', () => {
    expect(SERVER_MANAGED_ENTITIES.users.absentVerbs).toEqual(['create', 'delete'])
  })

  it('does not claim an ordinary entity name', () => {
    expect(isServerManagedEntityName('Bill')).toBe(false)
  })
})

describe('the managed field names', () => {
  it('names the managed set', () => {
    for (const name of ['id', 'created_at', 'updated_at', 'created_by'])
      expect(isServerManagedFieldName(name)).toBe(true)
    expect(isServerManagedFieldName('title')).toBe(false)
  })
})
