import { describe, expect, it } from 'vitest'
import type { ShareStatus } from '../team-share'

describe('ShareStatus shape', () => {
  it('carries link status and global path', () => {
    const s: ShareStatus = {
      mode: 'oss',
      linkStatus: 'symlink',
      globalPath: '/home/u/.amuxd/teams/team-1/teamclaw-team',
    }
    expect(s.linkStatus).toBe('symlink')
    expect(s.globalPath).toContain('.amuxd/teams/team-1')
  })

  it('allows the three link states', () => {
    const states: ShareStatus['linkStatus'][] = [
      'symlink',
      'real_dir',
      'missing',
    ]
    expect(states).toHaveLength(3)
  })
})
