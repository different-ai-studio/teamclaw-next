import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())
const teamProvider = vi.hoisted(() => ({
  loadTeamProviderFormState: vi.fn(),
  saveTeamProviderFile: vi.fn(),
  removeTeamProviderFile: vi.fn(),
  buildTeamProviderConfig: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/team-provider', () => teamProvider)

import { TeamSharedLlmPane } from '../TeamSharedLlmPane'

describe('TeamSharedLlmPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    teamProvider.buildTeamProviderConfig.mockReturnValue({ id: 'team' })
    teamProvider.saveTeamProviderFile.mockResolvedValue(undefined)
    teamProvider.removeTeamProviderFile.mockResolvedValue(undefined)
    mockInvoke.mockResolvedValue(undefined)
  })

  it('loads the existing team provider config when opened', async () => {
    teamProvider.loadTeamProviderFormState.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'gpt-x', name: 'GPT-X' }],
    })

    render(
      <TeamSharedLlmPane open onOpenChange={() => {}} workspacePath="/ws" />,
    )

    await waitFor(() => {
      expect(teamProvider.loadTeamProviderFormState).toHaveBeenCalledWith('/ws')
    })
    await waitFor(() => {
      const url = screen.getByPlaceholderText(
        'https://your-llm-proxy.com/v1',
      ) as HTMLInputElement
      expect(url.value).toBe('https://proxy.example.com/v1')
    })
  })

  it('persists via update_team_llm_config + saveTeamProviderFile on save', async () => {
    teamProvider.loadTeamProviderFormState.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'gpt-x', name: 'GPT-X' }],
    })

    render(
      <TeamSharedLlmPane open onOpenChange={() => {}} workspacePath="/ws" />,
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText('https://your-llm-proxy.com/v1')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('update_team_llm_config', {
        llmBaseUrl: 'https://proxy.example.com/v1',
        llmModel: 'gpt-x',
        llmModelName: 'GPT-X',
        llmModels: JSON.stringify([{ id: 'gpt-x', name: 'GPT-X' }]),
        workspacePath: '/ws',
      })
    })
    expect(teamProvider.saveTeamProviderFile).toHaveBeenCalledWith(
      '/ws',
      { id: 'team' },
      'gpt-x',
    )
    await waitFor(() => expect(screen.getByText(/已保存|Saved/)).toBeTruthy())
  })

  it('removes the provider file when the shared LLM is disabled on save', async () => {
    teamProvider.loadTeamProviderFormState.mockResolvedValue({
      enabled: false,
      baseUrl: '',
      models: [],
    })
    teamProvider.buildTeamProviderConfig.mockReturnValue(null)

    render(
      <TeamSharedLlmPane open onOpenChange={() => {}} workspacePath="/ws" />,
    )

    await waitFor(() =>
      expect(teamProvider.loadTeamProviderFormState).toHaveBeenCalled(),
    )

    fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('update_team_llm_config', {
        llmBaseUrl: null,
        llmModel: null,
        llmModelName: null,
        llmModels: null,
        workspacePath: '/ws',
      })
    })
    expect(teamProvider.removeTeamProviderFile).toHaveBeenCalledWith('/ws')
    expect(teamProvider.saveTeamProviderFile).not.toHaveBeenCalled()
  })
})
