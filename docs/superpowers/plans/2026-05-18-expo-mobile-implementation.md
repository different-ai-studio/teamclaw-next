# Expo Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `apps/expo` Expo Router app that reproduces the current iOS onboarding flow with real Supabase email OTP and anonymous auth, then lands the user in a minimal authenticated shell.

**Architecture:** The Expo app is a standalone workspace inside the monorepo. Route files stay thin and delegate to a reducer-backed onboarding store plus a small Supabase onboarding API. UI primitives and screens live under `apps/expo/src`, while root workspace files wire Expo into the existing pnpm/Vitest workflow.

**Tech Stack:** Expo Router, React Native, TypeScript, `@supabase/supabase-js`, `@react-native-async-storage/async-storage`, Vitest

---

## File Structure

### Root workspace files

- Modify: `pnpm-workspace.yaml`
  - add `apps/expo` to the pnpm workspace
- Modify: `package.json`
  - add Expo scripts such as `expo:dev`, `expo:ios`, `expo:android`, and `expo:test`

### Expo workspace files

- Create: `apps/expo/package.json`
  - workspace package manifest with Expo, Expo Router, Supabase, Vitest, and React Native dependencies
- Create: `apps/expo/app.json`
  - Expo app metadata
- Create: `apps/expo/babel.config.js`
  - Expo Router Babel plugin setup
- Create: `apps/expo/tsconfig.json`
  - TypeScript config extending Expo defaults
- Create: `apps/expo/.gitignore`
  - Expo and Metro artifacts
- Create: `apps/expo/.env.example`
  - Supabase public env variable template
- Create: `apps/expo/README.md`
  - local run instructions

### App route files

- Create: `apps/expo/app/_layout.tsx`
  - app providers and root slot
- Create: `apps/expo/app/index.tsx`
  - onboarding-state-driven redirect route
- Create: `apps/expo/app/welcome.tsx`
  - route wrapper for the welcome screen
- Create: `apps/expo/app/auth.tsx`
  - route wrapper for auth choice and email OTP flow
- Create: `apps/expo/app/create-team.tsx`
  - route wrapper for create-team flow
- Create: `apps/expo/app/(app)/_layout.tsx`
  - authenticated-shell layout
- Create: `apps/expo/app/(app)/home.tsx`
  - minimal authenticated shell route

### Onboarding domain files

- Create: `apps/expo/src/features/onboarding/onboarding-types.ts`
  - route enums, team summary shape, state, and action types
- Create: `apps/expo/src/features/onboarding/onboarding-reducer.ts`
  - pure reducer and initial state
- Create: `apps/expo/src/features/onboarding/onboarding-store.ts`
  - reducer-backed store, async bootstrap/actions, and provider hooks
- Create: `apps/expo/src/features/onboarding/screens/WelcomeScreen.tsx`
  - welcome UI
- Create: `apps/expo/src/features/onboarding/screens/AuthScreen.tsx`
  - auth choice + email OTP UI
- Create: `apps/expo/src/features/onboarding/screens/CreateTeamScreen.tsx`
  - create-team UI
- Create: `apps/expo/src/features/onboarding/screens/HomeScreen.tsx`
  - authenticated shell UI

### Supabase integration files

- Create: `apps/expo/src/lib/supabase/config.ts`
  - env loading and config validation
- Create: `apps/expo/src/lib/supabase/client.ts`
  - singleton Supabase client with AsyncStorage persistence
- Create: `apps/expo/src/lib/supabase/onboarding-api.ts`
  - focused onboarding API used by the onboarding store

### Shared UI files

- Create: `apps/expo/src/ui/theme.ts`
  - color and spacing tokens adapted from the repo visual language
- Create: `apps/expo/src/ui/button.tsx`
  - reusable primary and secondary button
- Create: `apps/expo/src/ui/input.tsx`
  - reusable text input wrapper
- Create: `apps/expo/src/ui/card.tsx`
  - reusable card surface

### Tests

- Create: `apps/expo/src/test/supabase-config.test.ts`
  - config validation tests
- Create: `apps/expo/src/test/onboarding-reducer.test.ts`
  - pure reducer transition tests
- Create: `apps/expo/src/test/onboarding-store.test.ts`
  - async bootstrap/auth flow tests with API mocks
- Create: `apps/expo/src/test/onboarding-api.test.ts`
  - API behavior and query shaping tests

## Task 1: Scaffold the Expo workspace and validate env loading

**Files:**
- Create: `apps/expo/package.json`
- Create: `apps/expo/app.json`
- Create: `apps/expo/babel.config.js`
- Create: `apps/expo/tsconfig.json`
- Create: `apps/expo/.gitignore`
- Create: `apps/expo/.env.example`
- Create: `apps/expo/README.md`
- Create: `apps/expo/src/lib/supabase/config.ts`
- Test: `apps/expo/src/test/supabase-config.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

- [ ] **Step 1: Write the failing env-config test**

```ts
// apps/expo/src/test/supabase-config.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

describe("getSupabaseConfig", () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    vi.resetModules();
  });

  it("returns the configured public Supabase values", async () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "demo-key";

    const { getSupabaseConfig } = await import("../lib/supabase/config");

    expect(getSupabaseConfig()).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "demo-key",
    });
  });

  it("throws when either public env var is missing", async () => {
    const { getSupabaseConfig } = await import("../lib/supabase/config");

    expect(() => getSupabaseConfig()).toThrow(
      "Missing Expo Supabase configuration",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/expo/src/test/supabase-config.test.ts`

Expected: FAIL with a module resolution error for `apps/expo/src/lib/supabase/config.ts` or the missing Expo workspace.

- [ ] **Step 3: Add the Expo workspace skeleton and minimal config implementation**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/expo"
allowBuilds:
  esbuild: false
  msw: false
```

```json
// package.json (scripts excerpt)
{
  "scripts": {
    "expo:dev": "pnpm --filter @teamclaw/expo dev",
    "expo:ios": "pnpm --filter @teamclaw/expo ios",
    "expo:android": "pnpm --filter @teamclaw/expo android",
    "expo:test": "pnpm --filter @teamclaw/expo test"
  }
}
```

```json
// apps/expo/package.json
{
  "name": "@teamclaw/expo",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "dev": "expo start --clear",
    "ios": "expo run:ios",
    "android": "expo run:android",
    "test": "vitest run src/test"
  },
  "dependencies": {
    "@react-native-async-storage/async-storage": "^2.2.0",
    "@supabase/supabase-js": "^2.49.8",
    "expo": "~54.0.0",
    "expo-router": "~5.1.0",
    "expo-status-bar": "~2.2.3",
    "react": "19.1.0",
    "react-native": "0.81.0",
    "react-native-safe-area-context": "^5.4.0",
    "react-native-screens": "^4.11.1"
  },
  "devDependencies": {
    "@types/react": "~19.1.10",
    "typescript": "~5.9.2",
    "vitest": "^2.1.0"
  }
}
```

```js
// apps/expo/babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["expo-router/babel"],
  };
};
```

```json
// apps/expo/tsconfig.json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["app", "src", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

```ts
// apps/expo/src/lib/supabase/config.ts
export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export function getSupabaseConfig(): SupabaseConfig {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const publishableKey =
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Expo Supabase configuration. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  return { url, publishableKey };
}
```

```env
# apps/expo/.env.example
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

```md
# apps/expo/README.md

## Expo app

1. Copy `.env.example` to `.env`
2. Fill in the Supabase public values
3. Run `pnpm install`
4. Start with `pnpm expo:dev`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run apps/expo/src/test/supabase-config.test.ts`

Expected: PASS with 2 tests passing.

- [ ] **Step 5: Commit the scaffolding**

```bash
git add pnpm-workspace.yaml package.json apps/expo
git commit -m "feat: scaffold expo workspace"
```

## Task 2: Build the onboarding types and reducer with red-green coverage

**Files:**
- Create: `apps/expo/src/features/onboarding/onboarding-types.ts`
- Create: `apps/expo/src/features/onboarding/onboarding-reducer.ts`
- Test: `apps/expo/src/test/onboarding-reducer.test.ts`

- [ ] **Step 1: Write the failing reducer tests**

```ts
// apps/expo/src/test/onboarding-reducer.test.ts
import { describe, expect, it } from "vitest";

import {
  initialOnboardingState,
  onboardingReducer,
} from "../features/onboarding/onboarding-reducer";
import type { TeamSummary } from "../features/onboarding/onboarding-types";

const team: TeamSummary = {
  id: "team-1",
  name: "Alpha",
  slug: "alpha",
  role: "owner",
};

describe("onboardingReducer", () => {
  it("stores the pending email after otp send", () => {
    const state = onboardingReducer(initialOnboardingState, {
      type: "otpRequested",
      email: "hi@example.com",
    });

    expect(state.pendingEmailOTPEmail).toBe("hi@example.com");
    expect(state.errorMessage).toBeNull();
  });

  it("moves to createTeam when bootstrap succeeds without teams", () => {
    const state = onboardingReducer(initialOnboardingState, {
      type: "bootstrapResolved",
      payload: {
        isAnonymous: true,
        team: null,
        memberActorId: null,
      },
    });

    expect(state.route).toBe("createTeam");
    expect(state.isAnonymous).toBe(true);
  });

  it("moves to ready when bootstrap returns a team", () => {
    const state = onboardingReducer(initialOnboardingState, {
      type: "bootstrapResolved",
      payload: {
        isAnonymous: false,
        team,
        memberActorId: "actor-1",
      },
    });

    expect(state.route).toBe("ready");
    expect(state.currentTeam).toEqual(team);
    expect(state.currentMemberActorId).toBe("actor-1");
  });

  it("moves to failed on bootstrap error", () => {
    const state = onboardingReducer(initialOnboardingState, {
      type: "bootstrapFailed",
      message: "Backend offline",
    });

    expect(state.route).toBe("failed");
    expect(state.errorMessage).toBe("Backend offline");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/expo/src/test/onboarding-reducer.test.ts`

Expected: FAIL because the onboarding reducer and types do not exist yet.

- [ ] **Step 3: Write the minimal reducer and type definitions**

```ts
// apps/expo/src/features/onboarding/onboarding-types.ts
export type OnboardingRoute =
  | "loading"
  | "needsAuth"
  | "createTeam"
  | "ready"
  | "failed";

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface BootstrapResult {
  isAnonymous: boolean;
  team: TeamSummary | null;
  memberActorId: string | null;
}

export interface OnboardingState {
  route: OnboardingRoute;
  isBusy: boolean;
  errorMessage: string | null;
  pendingEmailOTPEmail: string | null;
  currentTeam: TeamSummary | null;
  currentMemberActorId: string | null;
  isAnonymous: boolean;
}

export type OnboardingAction =
  | { type: "beginBusy" }
  | { type: "clearError" }
  | { type: "otpRequested"; email: string }
  | { type: "bootstrapResolved"; payload: BootstrapResult }
  | { type: "bootstrapFailed"; message: string }
  | { type: "signedOut" };
```

```ts
// apps/expo/src/features/onboarding/onboarding-reducer.ts
import type {
  OnboardingAction,
  OnboardingState,
} from "./onboarding-types";

export const initialOnboardingState: OnboardingState = {
  route: "loading",
  isBusy: false,
  errorMessage: null,
  pendingEmailOTPEmail: null,
  currentTeam: null,
  currentMemberActorId: null,
  isAnonymous: false,
};

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "beginBusy":
      return { ...state, isBusy: true, errorMessage: null };
    case "clearError":
      return { ...state, errorMessage: null };
    case "otpRequested":
      return {
        ...state,
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: action.email,
      };
    case "bootstrapResolved":
      return {
        ...state,
        isBusy: false,
        errorMessage: null,
        isAnonymous: action.payload.isAnonymous,
        currentTeam: action.payload.team,
        currentMemberActorId: action.payload.memberActorId,
        route: action.payload.team ? "ready" : "createTeam",
      };
    case "bootstrapFailed":
      return {
        ...state,
        isBusy: false,
        route: "failed",
        errorMessage: action.message,
      };
    case "signedOut":
      return {
        ...initialOnboardingState,
        route: "needsAuth",
      };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the reducer tests to verify they pass**

Run: `pnpm exec vitest run apps/expo/src/test/onboarding-reducer.test.ts`

Expected: PASS with 4 tests passing.

- [ ] **Step 5: Commit the reducer layer**

```bash
git add apps/expo/src/features/onboarding/onboarding-types.ts apps/expo/src/features/onboarding/onboarding-reducer.ts apps/expo/src/test/onboarding-reducer.test.ts
git commit -m "feat: add expo onboarding reducer"
```

## Task 3: Build the Supabase onboarding API with tests for bootstrap and OTP

**Files:**
- Create: `apps/expo/src/lib/supabase/client.ts`
- Create: `apps/expo/src/lib/supabase/onboarding-api.ts`
- Test: `apps/expo/src/test/onboarding-api.test.ts`

- [ ] **Step 1: Write the failing onboarding API tests**

```ts
// apps/expo/src/test/onboarding-api.test.ts
import { describe, expect, it, vi } from "vitest";

const createClient = () => ({
  auth: {
    getSession: vi.fn(),
    signInAnonymously: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
    getUser: vi.fn(),
  },
  from: vi.fn(),
  rpc: vi.fn(),
});

describe("createOnboardingApi", () => {
  it("returns null bootstrap team when the user has no memberships", async () => {
    const client = createClient();
    client.auth.getUser.mockResolvedValue({
      data: { user: { id: "user-1", is_anonymous: true } },
      error: null,
    });
    client.from
      .mockReturnValueOnce({
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: [], error: null }),
          }),
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          in: async () => ({ data: [], error: null }),
        }),
      });

    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const api = createOnboardingApi(client as never);

    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: true,
      team: null,
      memberActorId: null,
    });
  });

  it("records the email when OTP send succeeds", async () => {
    const client = createClient();
    client.auth.signInWithOtp.mockResolvedValue({ data: {}, error: null });

    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const api = createOnboardingApi(client as never);

    await expect(api.sendEmailOTP("hi@example.com")).resolves.toEqual({
      pendingEmail: "hi@example.com",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/expo/src/test/onboarding-api.test.ts`

Expected: FAIL because the onboarding API and client files do not exist yet.

- [ ] **Step 3: Write the minimal Supabase client wrapper and onboarding API**

```ts
// apps/expo/src/lib/supabase/client.ts
import "react-native-url-polyfill/auto";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

import { getSupabaseConfig } from "./config";

const { url, publishableKey } = getSupabaseConfig();

export const supabase = createClient(url, publishableKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
```

```ts
// apps/expo/src/lib/supabase/onboarding-api.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import type { BootstrapResult, TeamSummary } from "@/features/onboarding/onboarding-types";

interface TeamMembershipRow {
  member_id: string;
  role: string;
  teams: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

export function createOnboardingApi(client: SupabaseClient) {
  return {
    async getCurrentSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },

    async loadBootstrap(): Promise<BootstrapResult> {
      const {
        data: { user },
        error: userError,
      } = await client.auth.getUser();
      if (userError) throw userError;
      if (!user) {
        return { isAnonymous: false, team: null, memberActorId: null };
      }

      const { data: actors, error: actorError } = await client
        .from("actors")
        .select("id")
        .eq("user_id", user.id)
        .eq("actor_type", "member");
      if (actorError) throw actorError;

      const actorIds = ((actors as Array<{ id: string }> | null) ?? []).map(
        (actor) => actor.id,
      );
      if (actorIds.length === 0) {
        return {
          isAnonymous: !!user.is_anonymous,
          team: null,
          memberActorId: null,
        };
      }

      const { data, error } = await client
        .from("team_members")
        .select("member_id, role, teams!inner(id, name, slug)")
        .in("member_id", actorIds);
      if (error) throw error;

      const first = (data as TeamMembershipRow[] | null)?.[0];
      if (!first?.teams) {
        return {
          isAnonymous: !!user.is_anonymous,
          team: null,
          memberActorId: null,
        };
      }

      const team: TeamSummary = {
        id: first.teams.id,
        name: first.teams.name,
        slug: first.teams.slug,
        role: first.role,
      };

      return {
        isAnonymous: !!user.is_anonymous,
        team,
        memberActorId: first.member_id,
      };
    },

    async signInAnonymously() {
      const { error } = await client.auth.signInAnonymously();
      if (error) throw error;
    },

    async sendEmailOTP(email: string) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
        },
      });
      if (error) throw error;
      return { pendingEmail: email };
    },

    async verifyOTP(email: string, token: string) {
      const { error } = await client.auth.verifyOtp({
        email,
        token,
        type: "email",
      });
      if (error) throw error;
    },

    async createTeam(name: string) {
      const { data, error } = await client.rpc("create_team", {
        p_name: name,
      });
      if (error) throw error;
      return data;
    },

    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },
  };
}
```

- [ ] **Step 4: Run the onboarding API tests to verify they pass**

Run: `pnpm exec vitest run apps/expo/src/test/onboarding-api.test.ts`

Expected: PASS with 2 tests passing.

- [ ] **Step 5: Commit the API layer**

```bash
git add apps/expo/src/lib/supabase/client.ts apps/expo/src/lib/supabase/onboarding-api.ts apps/expo/src/test/onboarding-api.test.ts
git commit -m "feat: add expo onboarding api"
```

## Task 4: Build the onboarding store and async flow tests

**Files:**
- Create: `apps/expo/src/features/onboarding/onboarding-store.ts`
- Test: `apps/expo/src/test/onboarding-store.test.ts`

- [ ] **Step 1: Write the failing store tests**

```ts
// apps/expo/src/test/onboarding-store.test.ts
import { describe, expect, it, vi } from "vitest";

describe("createOnboardingController", () => {
  it("routes to needsAuth when no session exists", async () => {
    const api = {
      getCurrentSession: vi.fn().mockResolvedValue(null),
      loadBootstrap: vi.fn(),
      signInAnonymously: vi.fn(),
      sendEmailOTP: vi.fn(),
      verifyOTP: vi.fn(),
      createTeam: vi.fn(),
      signOut: vi.fn(),
    };

    const { createOnboardingController } = await import(
      "../features/onboarding/onboarding-store"
    );

    const controller = createOnboardingController(api);
    await controller.bootstrap();

    expect(controller.getState().route).toBe("needsAuth");
  });

  it("stores the pending email after otp request", async () => {
    const api = {
      getCurrentSession: vi.fn().mockResolvedValue(null),
      loadBootstrap: vi.fn(),
      signInAnonymously: vi.fn(),
      sendEmailOTP: vi.fn().mockResolvedValue({ pendingEmail: "hi@example.com" }),
      verifyOTP: vi.fn(),
      createTeam: vi.fn(),
      signOut: vi.fn(),
    };

    const { createOnboardingController } = await import(
      "../features/onboarding/onboarding-store"
    );

    const controller = createOnboardingController(api);
    await controller.requestOtp("hi@example.com");

    expect(controller.getState().pendingEmailOTPEmail).toBe("hi@example.com");
  });

  it("signs out back to needsAuth", async () => {
    const api = {
      getCurrentSession: vi.fn().mockResolvedValue({ access_token: "x" }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: { id: "team-1", name: "Alpha", slug: "alpha", role: "owner" },
        memberActorId: "actor-1",
      }),
      signInAnonymously: vi.fn(),
      sendEmailOTP: vi.fn(),
      verifyOTP: vi.fn(),
      createTeam: vi.fn(),
      signOut: vi.fn().mockResolvedValue(undefined),
    };

    const { createOnboardingController } = await import(
      "../features/onboarding/onboarding-store"
    );

    const controller = createOnboardingController(api);
    await controller.bootstrap();
    await controller.signOut();

    expect(controller.getState().route).toBe("needsAuth");
    expect(api.signOut).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/expo/src/test/onboarding-store.test.ts`

Expected: FAIL because the onboarding store/controller does not exist yet.

- [ ] **Step 3: Write the minimal onboarding controller implementation**

```ts
// apps/expo/src/features/onboarding/onboarding-store.ts
import { initialOnboardingState, onboardingReducer } from "./onboarding-reducer";
import type {
  BootstrapResult,
  OnboardingState,
} from "./onboarding-types";

export interface OnboardingApi {
  getCurrentSession(): Promise<unknown>;
  loadBootstrap(): Promise<BootstrapResult>;
  signInAnonymously(): Promise<void>;
  sendEmailOTP(email: string): Promise<{ pendingEmail: string }>;
  verifyOTP(email: string, token: string): Promise<void>;
  createTeam(name: string): Promise<unknown>;
  signOut(): Promise<void>;
}

export function createOnboardingController(api: OnboardingApi) {
  let state: OnboardingState = initialOnboardingState;
  const listeners = new Set<() => void>();

  const dispatch = (action: Parameters<typeof onboardingReducer>[1]) => {
    state = onboardingReducer(state, action);
    listeners.forEach((listener) => listener());
  };

  return {
    getState() {
      return state;
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async bootstrap() {
      try {
        dispatch({ type: "beginBusy" });
        const session = await api.getCurrentSession();
        if (!session) {
          state = {
            ...state,
            route: "needsAuth",
            isBusy: false,
            errorMessage: null,
          };
          listeners.forEach((listener) => listener());
          return;
        }

        const result = await api.loadBootstrap();
        dispatch({ type: "bootstrapResolved", payload: result });
      } catch (error) {
        dispatch({
          type: "bootstrapFailed",
          message: error instanceof Error ? error.message : "Bootstrap failed",
        });
      }
    },

    async signInAnonymously() {
      await api.signInAnonymously();
      await this.bootstrap();
    },

    async requestOtp(email: string) {
      dispatch({ type: "beginBusy" });
      const result = await api.sendEmailOTP(email);
      dispatch({ type: "otpRequested", email: result.pendingEmail });
    },

    async verifyOtp(token: string) {
      if (!state.pendingEmailOTPEmail) {
        throw new Error("No pending email available for verification.");
      }
      await api.verifyOTP(state.pendingEmailOTPEmail, token);
      await this.bootstrap();
    },

    async createTeam(name: string) {
      dispatch({ type: "beginBusy" });
      await api.createTeam(name);
      await this.bootstrap();
    },

    async signOut() {
      await api.signOut();
      dispatch({ type: "signedOut" });
    },
  };
}
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `pnpm exec vitest run apps/expo/src/test/onboarding-store.test.ts`

Expected: PASS with 3 tests passing.

- [ ] **Step 5: Commit the onboarding store**

```bash
git add apps/expo/src/features/onboarding/onboarding-store.ts apps/expo/src/test/onboarding-store.test.ts
git commit -m "feat: add expo onboarding store"
```

## Task 5: Build the shared UI primitives and route wrappers

**Files:**
- Create: `apps/expo/src/ui/theme.ts`
- Create: `apps/expo/src/ui/button.tsx`
- Create: `apps/expo/src/ui/input.tsx`
- Create: `apps/expo/src/ui/card.tsx`
- Create: `apps/expo/app/_layout.tsx`
- Create: `apps/expo/app/index.tsx`
- Create: `apps/expo/app/welcome.tsx`
- Create: `apps/expo/app/auth.tsx`
- Create: `apps/expo/app/create-team.tsx`
- Create: `apps/expo/app/(app)/_layout.tsx`
- Create: `apps/expo/app/(app)/home.tsx`

- [ ] **Step 1: Add the theme tokens and UI primitives**

```ts
// apps/expo/src/ui/theme.ts
export const theme = {
  colors: {
    background: "#fbfaf7",
    paper: "#ffffff",
    panel: "#efece4",
    foreground: "#1a1a14",
    ink2: "#3d3c34",
    muted: "#75736a",
    faint: "#a8a6a0",
    border: "rgba(26,26,20,0.08)",
    coral: "#e85a4a",
    coralSoft: "#f5d6cf",
  },
  radius: {
    section: 14,
    card: 16,
    button: 8,
    chip: 4,
  },
  spacing: {
    page: 24,
    card: 14,
    gap: 12,
  },
};
```

```tsx
// apps/expo/src/ui/button.tsx
import { Pressable, StyleSheet, Text } from "react-native";

import { theme } from "./theme";

export function PrimaryButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        disabled && styles.primaryDisabled,
        pressed && !disabled && styles.primaryPressed,
      ]}
    >
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    alignItems: "center",
    backgroundColor: theme.colors.coral,
    borderRadius: theme.radius.button,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  primaryDisabled: {
    opacity: 0.4,
  },
  primaryPressed: {
    opacity: 0.9,
  },
  primaryLabel: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
});
```

```tsx
// apps/expo/src/ui/input.tsx
import { StyleSheet, TextInput, type TextInputProps } from "react-native";

import { theme } from "./theme";

export function AppInput(props: TextInputProps) {
  return <TextInput placeholderTextColor={theme.colors.faint} style={styles.input} {...props} />;
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: theme.colors.paper,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    color: theme.colors.foreground,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
```

```tsx
// apps/expo/src/ui/card.tsx
import { View, StyleSheet, type ViewProps } from "react-native";

import { theme } from "./theme";

export function AppCard(props: ViewProps) {
  return <View {...props} style={[styles.card, props.style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.paper,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    padding: theme.spacing.card,
  },
});
```

- [ ] **Step 2: Add root layout and router redirect wrappers**

```tsx
// apps/expo/app/_layout.tsx
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
```

```tsx
// apps/expo/app/index.tsx
import { Redirect } from "expo-router";

export default function IndexRoute() {
  return <Redirect href="/welcome" />;
}
```

```tsx
// apps/expo/app/(app)/_layout.tsx
import { Stack } from "expo-router";

export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

```tsx
// apps/expo/app/(app)/home.tsx
export { HomeScreen as default } from "@/features/onboarding/screens/HomeScreen";
```

- [ ] **Step 3: Add the screen route wrappers**

```tsx
// apps/expo/app/welcome.tsx
export { WelcomeScreen as default } from "@/features/onboarding/screens/WelcomeScreen";
```

```tsx
// apps/expo/app/auth.tsx
export { AuthScreen as default } from "@/features/onboarding/screens/AuthScreen";
```

```tsx
// apps/expo/app/create-team.tsx
export { CreateTeamScreen as default } from "@/features/onboarding/screens/CreateTeamScreen";
```

- [ ] **Step 4: Run typecheck smoke verification**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`

Expected: PASS with no TypeScript errors in the shared UI or route wrappers.

- [ ] **Step 5: Commit the UI foundation**

```bash
git add apps/expo/src/ui apps/expo/app
git commit -m "feat: add expo route and ui foundation"
```

## Task 6: Implement the onboarding screens and authenticated shell

**Files:**
- Create: `apps/expo/src/features/onboarding/screens/WelcomeScreen.tsx`
- Create: `apps/expo/src/features/onboarding/screens/AuthScreen.tsx`
- Create: `apps/expo/src/features/onboarding/screens/CreateTeamScreen.tsx`
- Create: `apps/expo/src/features/onboarding/screens/HomeScreen.tsx`
- Modify: `apps/expo/app/index.tsx`
- Modify: `apps/expo/src/features/onboarding/onboarding-store.ts`

- [ ] **Step 1: Expand the onboarding store into a React provider hook**

```tsx
// apps/expo/src/features/onboarding/onboarding-store.ts (provider excerpt)
import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";

import { createOnboardingApi } from "@/lib/supabase/onboarding-api";
import { supabase } from "@/lib/supabase/client";

const OnboardingContext = createContext<ReturnType<typeof createOnboardingController> | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const controllerRef = useRef<ReturnType<typeof createOnboardingController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createOnboardingController(createOnboardingApi(supabase));
    void controllerRef.current.bootstrap();
  }
  return (
    <OnboardingContext.Provider value={controllerRef.current}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboardingController() {
  const controller = useContext(OnboardingContext);
  if (!controller) throw new Error("Missing OnboardingProvider");
  return controller;
}

export function useOnboardingState() {
  const controller = useOnboardingController();
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
```

- [ ] **Step 2: Wire the provider into the root layout and state redirect**

```tsx
// apps/expo/app/_layout.tsx
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { OnboardingProvider } from "@/features/onboarding/onboarding-store";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <OnboardingProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </OnboardingProvider>
    </SafeAreaProvider>
  );
}
```

```tsx
// apps/expo/app/index.tsx
import { Redirect } from "expo-router";

import { useOnboardingState } from "@/features/onboarding/onboarding-store";

export default function IndexRoute() {
  const { route } = useOnboardingState();

  if (route === "ready") return <Redirect href="/(app)/home" />;
  if (route === "createTeam") return <Redirect href="/create-team" />;
  if (route === "loading") return null;
  if (route === "failed") return <Redirect href="/welcome" />;
  if (route === "needsAuth") return <Redirect href="/welcome" />;
  return <Redirect href="/welcome" />;
}
```

- [ ] **Step 3: Implement the onboarding screens**

```tsx
// apps/expo/src/features/onboarding/screens/WelcomeScreen.tsx
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, Text, View } from "react-native";

import { PrimaryButton } from "@/ui/button";
import { theme } from "@/ui/theme";

export function WelcomeScreen() {
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.hero}>
        <Text style={styles.title}>Teamclaw</Text>
        <Text style={styles.subtitle}>AI digital employees for every role.</Text>
      </View>
      <PrimaryButton label="Get Started" onPress={() => router.push("/auth")} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: theme.colors.background,
    justifyContent: "space-between",
    padding: theme.spacing.page,
  },
  hero: {
    marginTop: 80,
    gap: 12,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: 44,
    fontWeight: "500",
  },
  subtitle: {
    color: theme.colors.ink2,
    fontSize: 18,
    lineHeight: 26,
  },
});
```

```tsx
// apps/expo/src/features/onboarding/screens/AuthScreen.tsx
import { router } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useOnboardingController, useOnboardingState } from "../onboarding-store";
import { AppCard } from "@/ui/card";
import { AppInput } from "@/ui/input";
import { PrimaryButton } from "@/ui/button";
import { theme } from "@/ui/theme";

export function AuthScreen() {
  const controller = useOnboardingController();
  const state = useOnboardingState();
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.stack}>
        <PrimaryButton
          label="Create a private workspace"
          onPress={async () => {
            await controller.signInAnonymously();
            router.replace("/create-team");
          }}
        />

        <AppCard style={styles.card}>
          <Text style={styles.heading}>
            {state.pendingEmailOTPEmail ? "Enter the code" : "Sign in with email"}
          </Text>
          {!state.pendingEmailOTPEmail ? (
            <>
              <AppInput
                autoCapitalize="none"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="Email"
                value={email}
              />
              <PrimaryButton
                disabled={!email}
                label="Send code"
                onPress={() => controller.requestOtp(email)}
              />
            </>
          ) : (
            <>
              <Text style={styles.caption}>Code sent to {state.pendingEmailOTPEmail}</Text>
              <AppInput
                keyboardType="number-pad"
                onChangeText={setToken}
                placeholder="8-digit code"
                value={token}
              />
              <PrimaryButton
                disabled={token.length !== 8}
                label="Verify"
                onPress={async () => {
                  await controller.verifyOtp(token);
                  router.replace(controller.getState().currentTeam ? "/(app)/home" : "/create-team");
                }}
              />
            </>
          )}
        </AppCard>

        <AppCard style={styles.card}>
          <Text style={styles.caption}>Apple sign-in is coming soon.</Text>
          <Text style={styles.caption}>Google sign-in is coming soon.</Text>
          <Text style={styles.link} onPress={() => Alert.alert("Coming soon", "Social sign-in lands after the email flow is stable.")}>
            Learn more
          </Text>
        </AppCard>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.page },
  stack: { gap: theme.spacing.gap, marginTop: 40 },
  card: { gap: 12 },
  heading: { color: theme.colors.foreground, fontSize: 28, fontWeight: "600" },
  caption: { color: theme.colors.ink2, fontSize: 14, lineHeight: 22 },
  link: { color: theme.colors.coral, fontSize: 14, fontWeight: "600" },
});
```

```tsx
// apps/expo/src/features/onboarding/screens/CreateTeamScreen.tsx
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useOnboardingController } from "../onboarding-store";
import { AppInput } from "@/ui/input";
import { PrimaryButton } from "@/ui/button";
import { theme } from "@/ui/theme";

export function CreateTeamScreen() {
  const controller = useOnboardingController();
  const [teamName, setTeamName] = useState("");

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.stack}>
        <Text style={styles.title}>Create your team</Text>
        <Text style={styles.subtitle}>Name the team you want to collaborate with.</Text>
        <AppInput onChangeText={setTeamName} placeholder="Teamclaw Team" value={teamName} />
        <PrimaryButton
          disabled={!teamName}
          label="Create Team"
          onPress={async () => {
            await controller.createTeam(teamName);
            router.replace("/(app)/home");
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.page },
  stack: { gap: theme.spacing.gap, marginTop: 100 },
  title: { color: theme.colors.foreground, fontSize: 34, fontWeight: "600" },
  subtitle: { color: theme.colors.ink2, fontSize: 16, lineHeight: 24 },
});
```

```tsx
// apps/expo/src/features/onboarding/screens/HomeScreen.tsx
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { router } from "expo-router";

import { useOnboardingController, useOnboardingState } from "../onboarding-store";
import { AppCard } from "@/ui/card";
import { PrimaryButton } from "@/ui/button";
import { theme } from "@/ui/theme";

export function HomeScreen() {
  const controller = useOnboardingController();
  const state = useOnboardingState();

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.stack}>
        <Text style={styles.title}>{state.currentTeam?.name ?? "Teamclaw"}</Text>
        <AppCard style={styles.card}>
          <Text style={styles.label}>Member Actor</Text>
          <Text style={styles.value}>{state.currentMemberActorId ?? "Not available yet"}</Text>
        </AppCard>
        <AppCard style={styles.card}>
          <Text style={styles.label}>Account Mode</Text>
          <Text style={styles.value}>{state.isAnonymous ? "Anonymous" : "Authenticated"}</Text>
        </AppCard>
        <AppCard style={styles.card}>
          <Text style={styles.label}>Next Up</Text>
          <Text style={styles.value}>Realtime sessions and team messaging land in the next phase.</Text>
        </AppCard>
        <PrimaryButton
          label="Sign Out"
          onPress={async () => {
            await controller.signOut();
            router.replace("/welcome");
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.background, padding: theme.spacing.page },
  stack: { gap: theme.spacing.gap, marginTop: 40 },
  title: { color: theme.colors.foreground, fontSize: 32, fontWeight: "600" },
  card: { gap: 8 },
  label: { color: theme.colors.faint, fontSize: 12, fontWeight: "600" },
  value: { color: theme.colors.foreground, fontSize: 16, lineHeight: 24 },
});
```

- [ ] **Step 4: Run the Expo workspace test and typecheck suite**

Run: `pnpm expo:test && pnpm --filter @teamclaw/expo exec tsc --noEmit`

Expected: PASS with the reducer/store/API tests green and no TypeScript errors.

- [ ] **Step 5: Commit the first working Expo UI**

```bash
git add apps/expo/app apps/expo/src
git commit -m "feat: add expo onboarding screens"
```

## Task 7: Verify local run workflow and tighten docs

**Files:**
- Modify: `apps/expo/README.md`
- Modify: `apps/expo/package.json`
- Modify: `package.json`

- [ ] **Step 1: Install dependencies and ensure the workspace resolves**

Run: `pnpm install`

Expected: PASS with a lockfile update that includes the Expo workspace packages.

- [ ] **Step 2: Start Expo and verify the dev entrypoint**

Run: `pnpm expo:dev`

Expected: Expo dev server starts successfully and prints a QR/local launcher prompt without missing-module errors.

- [ ] **Step 3: Validate the first-run flows manually**

Run these manual checks in the simulator or Expo Go build:

```text
1. Launch with no session and confirm the app lands on Welcome.
2. Choose anonymous sign-in and confirm the app reaches Create Team.
3. Sign out from Home and confirm the app returns to Welcome.
4. Use email OTP and confirm the verify step keeps the pending email visible.
5. Create a team after auth and confirm Home shows the chosen team name.
```

Expected: All five checks succeed without navigation dead ends.

- [ ] **Step 4: Update the README with the final run instructions**

```md
# apps/expo/README.md

## Commands

- `pnpm expo:dev` - start the Expo dev server
- `pnpm expo:ios` - build and run the iOS native shell
- `pnpm expo:android` - build and run the Android native shell
- `pnpm expo:test` - run the Expo Vitest suite

## Required env vars

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

## Phase 1 scope

This app currently supports welcome, anonymous sign-in, email OTP, create-team, and a minimal authenticated shell.
```

- [ ] **Step 5: Commit the run workflow polish**

```bash
git add apps/expo/README.md apps/expo/package.json package.json pnpm-lock.yaml
git commit -m "docs: finalize expo run workflow"
```

## Self-Review

### Spec coverage check

- `apps/expo` workspace creation is covered by Task 1 and Task 7
- Expo Router structure is covered by Task 5
- onboarding reducer/store and state-driven routing are covered by Task 2, Task 4, and Task 6
- real Supabase email OTP, anonymous auth, create-team, and sign-out are covered by Task 3, Task 4, and Task 6
- minimal authenticated shell is covered by Task 6
- test coverage and manual verification are covered by Task 2, Task 3, Task 4, and Task 7
- scripts and local docs are covered by Task 1 and Task 7

No spec gaps remain for phase 1.

### Placeholder scan

- No `TODO`, `TBD`, or deferred implementation placeholders remain inside the plan tasks
- Each task includes exact file paths, commands, and concrete code snippets
- The intentionally deferred product areas stay in the design spec, not hidden in implementation steps

### Type consistency check

- `OnboardingRoute`, `TeamSummary`, and `BootstrapResult` are defined once in `onboarding-types.ts`
- reducer action names used in Task 4 match the reducer defined in Task 2
- Supabase API method names used in Task 4 are defined in Task 3

Plan is internally consistent.
