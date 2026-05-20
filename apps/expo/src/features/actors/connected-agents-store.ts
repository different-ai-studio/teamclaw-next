import type { AgentAccessApi } from "./agent-access-api";
import type { ConnectedAgentsCache } from "./connected-agents-cache";
import type {
  ConnectedAgent,
  RuntimeInfo,
} from "./connected-agent-types";

export type ConnectedAgentsStoreState = {
  agents: ConnectedAgent[];
  runtimeInfoByAgentId: ReadonlyMap<string, RuntimeInfo>;
  isLoading: boolean;
  errorMessage: string | null;
};

type Subscriber = {
  watchDevice: (deviceId: string) => void;
  unwatchDevice: (deviceId: string) => void;
  watchedDevices: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  teamId: string;
  api: AgentAccessApi;
  subscriber: Subscriber;
  cache?: ConnectedAgentsCache;
};

export type ConnectedAgentsStore = {
  subscribe: (listener: () => void) => () => void;
  getState: () => ConnectedAgentsStoreState;
  reload: () => Promise<void>;
  shareToTeam: (agentId: string) => Promise<boolean>;
  makePersonal: (agentId: string) => Promise<boolean>;
  handleRuntimeInfo: (deviceId: string, runtimeId: string, info: RuntimeInfo) => void;
  dispose: () => Promise<void>;
};

const EMPTY_MAP: ReadonlyMap<string, RuntimeInfo> = new Map();

export function createConnectedAgentsStore(deps: Deps): ConnectedAgentsStore {
  let state: ConnectedAgentsStoreState = {
    agents: [],
    runtimeInfoByAgentId: EMPTY_MAP,
    isLoading: false,
    errorMessage: null,
  };
  const listeners = new Set<() => void>();

  function setState(next: ConnectedAgentsStoreState) {
    state = next;
    for (const l of listeners) l();
  }

  function diffWatches(prev: ConnectedAgent[], next: ConnectedAgent[]) {
    const prevDevices = new Set(prev.map((a) => a.deviceId).filter(Boolean) as string[]);
    const nextDevices = new Set(next.map((a) => a.deviceId).filter(Boolean) as string[]);
    for (const id of prevDevices) if (!nextDevices.has(id)) deps.subscriber.unwatchDevice(id);
    for (const id of nextDevices) if (!prevDevices.has(id)) deps.subscriber.watchDevice(id);
  }

  const store: ConnectedAgentsStore = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() { return state; },
    async reload() {
      setState({ ...state, isLoading: true, errorMessage: null });
      try {
        const agents = await deps.api.listConnectedAgents(deps.teamId);
        diffWatches(state.agents, agents);
        setState({ ...state, agents, isLoading: false, errorMessage: null });
        void deps.cache?.saveCache(deps.teamId, agents);
      } catch (err) {
        setState({
          ...state,
          isLoading: false,
          errorMessage: err instanceof Error ? err.message : "Couldn't load agents.",
        });
      }
    },
    async shareToTeam(agentId: string) {
      try {
        await deps.api.shareAgentToTeam(agentId);
        await store.reload();
        return true;
      } catch (err) {
        setState({ ...state, errorMessage: err instanceof Error ? err.message : "Failed." });
        return false;
      }
    },
    async makePersonal(agentId: string) {
      try {
        await deps.api.makeAgentPersonal(agentId);
        await store.reload();
        return true;
      } catch (err) {
        setState({ ...state, errorMessage: err instanceof Error ? err.message : "Failed." });
        return false;
      }
    },
    handleRuntimeInfo(deviceId: string, _runtimeId: string, info: RuntimeInfo) {
      const agentIdx = state.agents.findIndex((a) => a.deviceId === deviceId);
      if (agentIdx < 0) return;
      const next = state.agents.slice();
      next[agentIdx] = { ...next[agentIdx], lastActiveAt: new Date().toISOString() };
      const map = new Map(state.runtimeInfoByAgentId);
      map.set(next[agentIdx].agentId, info);
      setState({ ...state, agents: next, runtimeInfoByAgentId: map });
    },
    async dispose() {
      deps.subscriber.dispose();
      listeners.clear();
    },
  };
  return store;
}
