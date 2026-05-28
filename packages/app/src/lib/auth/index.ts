export type {
  AuthChangeEvent,
  AuthListener,
  AuthUser,
  OtpType,
  Session,
  Unsubscribe,
} from "./types";
export { AuthError } from "./types";
export {
  getSession,
  setSession,
  subscribe,
  subscribe as onAuthStateChange,
  refreshSession,
  configureSessionStore,
  __resetSessionStoreForTests,
} from "./session-store";
export { createAuthClient, type AuthClient } from "./auth-client";
