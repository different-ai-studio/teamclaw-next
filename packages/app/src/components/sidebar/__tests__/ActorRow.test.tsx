import * as React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActorRow } from '../ActorRow'
import type { ActorRow as ActorRowData } from '@/components/panel/ActorsView'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
  }),
}))

const baseActor: ActorRowData = {
  id: 'actor-1',
  actor_type: 'member',
  display_name: 'Alice',
  member_status: null,
  agent_status: null,
  last_active_at: null,
}

function setup(overrides: Partial<React.ComponentProps<typeof ActorRow>> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onViewDetail: vi.fn(),
    onCopyName: vi.fn(),
    onCopyId: vi.fn(),
    onRequestRemove: vi.fn(),
  }
  render(<ActorRow actor={baseActor} active={false} {...handlers} {...overrides} />)
  return handlers
}

function openMenu() {
  const trigger = screen.getByText('Alice').closest('button')!
  // Radix ContextMenu listens on pointerdown with button === 2
  fireEvent.pointerDown(trigger, { button: 2, ctrlKey: false })
  fireEvent.contextMenu(trigger)
}

describe('ActorRow', () => {
  it('left click selects', () => {
    const h = setup()
    fireEvent.click(screen.getByText('Alice'))
    expect(h.onSelect).toHaveBeenCalledWith(baseActor)
  })

  it('right click → View profile → onViewDetail', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('View profile'))
    expect(h.onViewDetail).toHaveBeenCalledWith(baseActor)
  })

  it('right click → Copy name → onCopyName', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Copy name'))
    expect(h.onCopyName).toHaveBeenCalledWith(baseActor)
  })

  it('right click → Copy ID → onCopyId', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Copy ID'))
    expect(h.onCopyId).toHaveBeenCalledWith(baseActor)
  })

  it('right click → Remove from team → onRequestRemove', async () => {
    const h = setup()
    openMenu()
    fireEvent.click(await screen.findByText('Remove from team'))
    expect(h.onRequestRemove).toHaveBeenCalledWith(baseActor)
  })
})
