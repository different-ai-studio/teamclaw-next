import { create } from 'zustand'

interface MqttReconnectState {
  nonce: number
  bump: () => void
}

export const useMqttReconnectStore = create<MqttReconnectState>((set, get) => ({
  nonce: 0,
  bump: () => set({ nonce: get().nonce + 1 }),
}))
