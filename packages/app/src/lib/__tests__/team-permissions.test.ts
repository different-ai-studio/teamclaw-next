import { describe, it, expect } from 'vitest'
import { permissionsForRole } from '../team-permissions'

describe('permissionsForRole', () => {
  it('owner can do everything', () => {
    expect(permissionsForRole('owner')).toEqual({
      role: 'owner', isOwner: true, canManageTeam: true, canEditFiles: true,
    })
  })
  it('admin manages + edits but is not owner', () => {
    expect(permissionsForRole('admin')).toEqual({
      role: 'admin', isOwner: false, canManageTeam: true, canEditFiles: true,
    })
  })
  it('member is read-only and cannot manage', () => {
    expect(permissionsForRole('member')).toEqual({
      role: 'member', isOwner: false, canManageTeam: false, canEditFiles: false,
    })
  })
  it('null / unknown role: no team — management denied, editing allowed (solo case)', () => {
    expect(permissionsForRole(null)).toEqual({
      role: null, isOwner: false, canManageTeam: false, canEditFiles: true,
    })
    expect(permissionsForRole('bogus')).toEqual({
      role: null, isOwner: false, canManageTeam: false, canEditFiles: true,
    })
  })
  it('normalizes case', () => {
    expect(permissionsForRole('Owner').isOwner).toBe(true)
  })
})
