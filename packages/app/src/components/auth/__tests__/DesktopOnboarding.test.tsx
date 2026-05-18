import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { authState, hasConfig, saveServerConfig, reload } = vi.hoisted(() => ({
  authState: {
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    signInAnonymously: vi.fn(),
    claimInviteAfterAnonymousSignIn: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
  },
  hasConfig: { value: true },
  saveServerConfig: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

vi.mock("@/lib/server-config", () => ({
  saveServerConfig,
}));

vi.mock("@/lib/supabase-client", () => ({
  get hasSupabaseConfig() {
    return hasConfig.value;
  },
}));

vi.mock("@/lib/version", () => ({
  useAppVersion: () => "0.1.0",
}));

vi.mock("@/lib/build-config", () => ({
  buildConfig: { app: { name: "TeamClaw" } },
}));

import { DesktopOnboarding } from "../DesktopOnboarding";

beforeEach(() => {
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.signInAnonymously.mockReset();
  authState.claimInviteAfterAnonymousSignIn.mockReset();
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  hasConfig.value = true;
  saveServerConfig.mockReset();
  window.__TEAMCLAW_SERVER_CONFIG__ = undefined;
  Object.defineProperty(window, "location", {
    value: { reload },
    writable: true,
    configurable: true,
  });
  reload.mockReset();
});

describe("DesktopOnboarding", () => {
  it("shows the four setup choices after welcome", () => {
    const { container } = render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(container.querySelector("[data-tauri-drag-region]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /quick trial/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in or register/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join the team/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /self-hosted server/i })).toBeInTheDocument();
  });

  it("quick trial signs in anonymously", async () => {
    authState.signInAnonymously.mockResolvedValueOnce(true);
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /quick trial/i }));

    await waitFor(() => expect(authState.signInAnonymously).toHaveBeenCalled());
  });

  it("shows quick trial auth errors on the choices screen", () => {
    authState.errorMessage = "Supabase config missing. Configure a server before signing in.";
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(screen.getByText(/supabase config missing/i)).toBeInTheDocument();
  });

  it("join team accepts a bare token and claims after anonymous sign-in", async () => {
    authState.claimInviteAfterAnonymousSignIn.mockResolvedValueOnce({ teamId: "team-1" });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /join the team/i }));
    fireEvent.change(screen.getByLabelText(/invite link/i), { target: { value: "tok-123" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(authState.claimInviteAfterAnonymousSignIn).toHaveBeenCalledWith("tok-123"),
    );
  });

  it("login path reuses the email OTP form", () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in or register/i }));

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it("login path disables OTP when Supabase config is missing", () => {
    hasConfig.value = false;
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in or register/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });

    expect(screen.getByText(/supabase is not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeDisabled();
  });

  it("self-hosted server saves config, updates injected config, and reloads", async () => {
    saveServerConfig.mockResolvedValueOnce({
      supabaseUrl: "https://self.supabase.co",
      supabaseAnonKey: "anon",
      mqttHost: "mqtt.example.com",
      mqttPort: 1883,
    });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /self-hosted server/i }));
    fireEvent.change(screen.getByLabelText(/supabase url/i), {
      target: { value: "https://self.supabase.co" },
    });
    fireEvent.change(screen.getByLabelText(/anon key/i), { target: { value: "anon" } });
    fireEvent.change(screen.getByLabelText(/mqtt host/i), { target: { value: "mqtt.example.com" } });
    fireEvent.change(screen.getByLabelText(/mqtt port/i), { target: { value: "1883" } });
    fireEvent.click(screen.getByRole("button", { name: /save and restart/i }));

    await waitFor(() => expect(saveServerConfig).toHaveBeenCalled());
    expect(window.__TEAMCLAW_SERVER_CONFIG__?.supabaseUrl).toBe("https://self.supabase.co");
    expect(reload).toHaveBeenCalled();
  });
});
