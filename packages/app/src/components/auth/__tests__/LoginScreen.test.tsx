import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState, backendConfig } = vi.hoisted(() => ({
  authState: {
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
    signInAnonymously: vi.fn(),
  },
  backendConfig: {
    hasConfig: true,
    kind: "supabase" as "supabase" | "pocketbase",
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: () => authState,
}));

vi.mock("@/lib/backend", () => ({
  hasBackendConfig: () => backendConfig.hasConfig,
  getBackendKind: () => backendConfig.kind,
}));

vi.mock("@/lib/version", () => ({
  useAppVersion: () => "0.1.0",
}));

vi.mock("@/lib/build-config", () => ({
  buildConfig: { app: { name: "TeamClaw" } },
}));

import { LoginScreen } from "../LoginScreen";

beforeEach(() => {
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  authState.signInAnonymously.mockReset();
  backendConfig.hasConfig = true;
  backendConfig.kind = "supabase";
});

describe("LoginScreen", () => {
  it("uses quick trial instead of OTP for PocketBase preview", async () => {
    backendConfig.kind = "pocketbase";
    authState.signInAnonymously.mockResolvedValueOnce(true);

    render(<LoginScreen />);

    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /quick trial/i }));

    await waitFor(() => expect(authState.signInAnonymously).toHaveBeenCalled());
    expect(authState.sendOtp).not.toHaveBeenCalled();
  });
});
