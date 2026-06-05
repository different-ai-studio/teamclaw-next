import { describe, it, expect } from 'vitest'
import {
  buildEmptyThreadStarters,
  formatEmptyThreadRosterNames,
  resolveEmptyThreadRoutingKind,
  type EmptyThreadParticipant,
} from '../session-empty-thread-starters'

const you = (id = 'me'): EmptyThreadParticipant => ({
  actorId: id,
  displayName: 'You',
  isAgent: false,
  isSelf: true,
})

const agent = (id: string, name: string): EmptyThreadParticipant => ({
  actorId: id,
  displayName: name,
  isAgent: true,
  isSelf: false,
})

const member = (id: string, name: string): EmptyThreadParticipant => ({
  actorId: id,
  displayName: name,
  isAgent: false,
  isSelf: false,
})

describe('session-empty-thread-starters', () => {
  it('resolveEmptyThreadRoutingKind detects solo agent pair', () => {
    expect(resolveEmptyThreadRoutingKind([you(), agent('a1', 'MAC')])).toBe('soloAgent')
  })

  it('resolveEmptyThreadRoutingKind detects single agent in group', () => {
    expect(resolveEmptyThreadRoutingKind([you(), member('m1', 'Matt'), agent('a1', 'MAC')])).toBe(
      'singleAgent',
    )
  })

  it('resolveEmptyThreadRoutingKind detects multiple agents', () => {
    expect(
      resolveEmptyThreadRoutingKind([you(), agent('a1', 'MAC'), agent('a2', 'Codex')]),
    ).toBe('multiAgent')
  })

  it('formatEmptyThreadRosterNames uses self label and separator', () => {
    const names = formatEmptyThreadRosterNames(
      [you(), agent('a1', 'MACMINI')],
      '你',
      '、',
    )
    expect(names).toBe('你、MACMINI')
  })

  it('buildEmptyThreadStarters returns duo shortcuts for you + sole agent', () => {
    const starters = buildEmptyThreadStarters([you(), agent('a1', 'MAC')])
    expect(starters).toHaveLength(2)
    expect(starters[0]?.id).toBe('workspace-changes')
  })

  it('buildEmptyThreadStarters returns @ starters for mixed group', () => {
    const starters = buildEmptyThreadStarters([
      you(),
      member('m1', 'Matt'),
      agent('a1', 'MAC'),
      agent('a2', 'Codex'),
    ])
    expect(starters.length).toBeGreaterThanOrEqual(2)
    expect(starters.some((s) => s.id.startsWith('agent-summary-'))).toBe(true)
    expect(starters.some((s) => s.id === 'broadcast')).toBe(true)
  })
})
