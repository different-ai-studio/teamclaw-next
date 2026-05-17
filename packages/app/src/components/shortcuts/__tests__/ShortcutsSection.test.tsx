import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/shortcuts', () => {
  const storeState = {
    personalNodes: [] as unknown[],
    teamNodes: [] as unknown[],
    addNode: vi.fn().mockResolvedValue('id'),
    updateNode: vi.fn().mockResolvedValue(undefined),
    deleteNode: vi.fn().mockResolvedValue(undefined),
    batchMove: vi.fn().mockResolvedValue(undefined),
    getChildren: vi.fn(() => []),
  }
  const useShortcutsStore: any = vi.fn((selector?: (s: typeof storeState) => unknown) => {
    return selector ? selector(storeState) : storeState
  })
  useShortcutsStore.getState = () => storeState
  return {
    useShortcutsStore,
    buildTree: vi.fn(() => []),
    ShortcutNode: {},
  }
})
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => null,
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}))

import { ShortcutsSection } from '../ShortcutsSection'

describe('ShortcutsSection', () => {
  it('renders without crashing', () => {
    const { container } = render(<ShortcutsSection />)
    expect(container).toBeTruthy()
  })
})
