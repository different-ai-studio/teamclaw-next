import { groupSessionsByRecency, type SessionGroup, type SessionSummary } from "./session-types";
import { setUnreadSessionCount } from "./unread-store";

type SessionsApi = ReturnType<(typeof import("./session-api"))["createSessionsApi"]>;

type SessionsControllerListener = () => void;

export type SessionsControllerStatus = "idle" | "loading" | "empty" | "loaded" | "error" | "refreshing";

export interface SessionsControllerState {
  status: SessionsControllerStatus;
  sessions: SessionSummary[];
  groups: SessionGroup[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
}

const INITIAL_STATE: SessionsControllerState = {
  status: "idle",
  sessions: [],
  groups: [],
  isLoading: false,
  isRefreshing: false,
  errorMessage: null,
};

function buildDerivedState(sessions: SessionSummary[]): SessionsControllerState {
  const groups = groupSessionsByRecency(sessions);

  return {
    status: sessions.length === 0 ? "empty" : "loaded",
    sessions,
    groups,
    isLoading: false,
    isRefreshing: false,
    errorMessage: null,
  };
}

function buildLoadingState(previousState: SessionsControllerState, preserveRows: boolean, refreshing: boolean): SessionsControllerState {
  return {
    status: refreshing ? "refreshing" : "loading",
    sessions: preserveRows ? previousState.sessions : [],
    groups: preserveRows ? previousState.groups : [],
    isLoading: !refreshing,
    isRefreshing: refreshing,
    errorMessage: null,
  };
}

function buildErrorState(previousState: SessionsControllerState, preserveRows: boolean, message: string): SessionsControllerState {
  return {
    status: "error",
    sessions: preserveRows ? previousState.sessions : [],
    groups: preserveRows ? previousState.groups : [],
    isLoading: false,
    isRefreshing: false,
    errorMessage: message,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export function createSessionsController(
  api: SessionsApi,
  teamId: string,
  currentActorId?: string | null,
) {
  let state = INITIAL_STATE;
  let requestId = 0;
  const listeners = new Set<SessionsControllerListener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (nextState: SessionsControllerState) => {
    state = nextState;
    notify();
  };

  const beginRequest = (mode: "load" | "refresh") => {
    requestId += 1;
    const currentRequestId = requestId;
    const preserveRows = mode === "refresh" && state.sessions.length > 0;
    setState(buildLoadingState(state, preserveRows, mode === "refresh" && preserveRows));
    return { currentRequestId, preserveRows };
  };

  const isCurrentRequest = (id: number) => id === requestId;

  const load = async () => {
    const { currentRequestId } = beginRequest("load");

    try {
      const sessions = await api.listSessions(teamId, currentActorId ?? undefined);
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setUnreadSessionCount(sessions.filter((s) => s.hasUnread).length);
      setState(buildDerivedState(sessions));
    } catch (error) {
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setState(buildErrorState(state, false, toErrorMessage(error)));
    }
  };

  const refresh = async () => {
    const { currentRequestId, preserveRows } = beginRequest("refresh");

    try {
      const sessions = await api.listSessions(teamId, currentActorId ?? undefined);
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setUnreadSessionCount(sessions.filter((s) => s.hasUnread).length);
      setState(buildDerivedState(sessions));
    } catch (error) {
      if (!isCurrentRequest(currentRequestId)) {
        return;
      }

      setState(buildErrorState(state, preserveRows, toErrorMessage(error)));
    }
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener: SessionsControllerListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    refresh,
  };
}
