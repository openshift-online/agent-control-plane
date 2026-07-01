import { describe, it, expect } from 'vitest'
import {
  RoleName,
  isViewerTier,
  isEditorTier,
  isAdminTier,
  canStartSession,
  canManageSchedules,
  canManageAgents,
} from '../roles'

describe('Gateway Mode Tier Functions', () => {
  describe('isViewerTier', () => {
    it('returns true for viewer roles', () => {
      expect(isViewerTier(RoleName.ProjectViewer)).toBe(true)
      expect(isViewerTier(RoleName.AgentObserver)).toBe(true)
      expect(isViewerTier(RoleName.PlatformViewer)).toBe(true)
      expect(isViewerTier(RoleName.CredentialViewer)).toBe(true)
    })

    it('returns false for non-viewer roles', () => {
      expect(isViewerTier(RoleName.ProjectEditor)).toBe(false)
      expect(isViewerTier(RoleName.ProjectOwner)).toBe(false)
      expect(isViewerTier(RoleName.PlatformAdmin)).toBe(false)
    })

    it('returns true for null role', () => {
      expect(isViewerTier(null)).toBe(true)
    })
  })

  describe('isEditorTier', () => {
    it('returns true for editor roles', () => {
      expect(isEditorTier(RoleName.ProjectEditor)).toBe(true)
      expect(isEditorTier(RoleName.AgentOperator)).toBe(true)
    })

    it('returns false for non-editor roles', () => {
      expect(isEditorTier(RoleName.ProjectViewer)).toBe(false)
      expect(isEditorTier(RoleName.ProjectOwner)).toBe(false)
      expect(isEditorTier(RoleName.PlatformAdmin)).toBe(false)
    })

    it('returns false for null role', () => {
      expect(isEditorTier(null)).toBe(false)
    })
  })

  describe('isAdminTier', () => {
    it('returns true for admin roles', () => {
      expect(isAdminTier(RoleName.PlatformAdmin)).toBe(true)
      expect(isAdminTier(RoleName.ProjectOwner)).toBe(true)
    })

    it('returns false for non-admin roles', () => {
      expect(isAdminTier(RoleName.ProjectEditor)).toBe(false)
      expect(isAdminTier(RoleName.ProjectViewer)).toBe(false)
      expect(isAdminTier(RoleName.AgentOperator)).toBe(false)
    })

    it('returns false for null role', () => {
      expect(isAdminTier(null)).toBe(false)
    })
  })

  describe('canStartSession', () => {
    it('returns true for admin and editor tiers', () => {
      expect(canStartSession(RoleName.PlatformAdmin)).toBe(true)
      expect(canStartSession(RoleName.ProjectOwner)).toBe(true)
      expect(canStartSession(RoleName.ProjectEditor)).toBe(true)
      expect(canStartSession(RoleName.AgentOperator)).toBe(true)
    })

    it('returns false for viewer tier', () => {
      expect(canStartSession(RoleName.ProjectViewer)).toBe(false)
      expect(canStartSession(RoleName.AgentObserver)).toBe(false)
    })

    it('returns false for null role', () => {
      expect(canStartSession(null)).toBe(false)
    })
  })

  describe('canManageSchedules', () => {
    it('returns true for admin and editor tiers', () => {
      expect(canManageSchedules(RoleName.PlatformAdmin)).toBe(true)
      expect(canManageSchedules(RoleName.ProjectOwner)).toBe(true)
      expect(canManageSchedules(RoleName.ProjectEditor)).toBe(true)
      expect(canManageSchedules(RoleName.AgentOperator)).toBe(true)
    })

    it('returns false for viewer tier', () => {
      expect(canManageSchedules(RoleName.ProjectViewer)).toBe(false)
      expect(canManageSchedules(RoleName.AgentObserver)).toBe(false)
    })

    it('returns false for null role', () => {
      expect(canManageSchedules(null)).toBe(false)
    })
  })

  describe('canManageAgents', () => {
    it('returns false when gateway mode is active', () => {
      expect(canManageAgents(true)).toBe(false)
    })

    it('returns true when gateway mode is inactive', () => {
      expect(canManageAgents(false)).toBe(true)
    })
  })
})
