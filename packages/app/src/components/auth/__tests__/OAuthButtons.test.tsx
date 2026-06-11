import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn() }));
vi.mock("@/lib/utils", async (orig) => ({ ...(await orig<object>()), isTauri: isTauriMock }));
vi.mock("@/lib/build-config", async (importOriginal) => {
  const actual = await importOriginal<{ buildConfig: Record<string, unknown> }>();
  return {
    ...actual,
    buildConfig: {
      ...actual.buildConfig,
      features: {
        ...(actual.buildConfig.features as Record<string, unknown>),
        auth: { google: true, wechat: true },
      },
    },
  };
});

import { OAuthButtons } from "../LoginScreen";

beforeEach(() => isTauriMock.mockReset());
afterEach(() => act(() => useAuthStore.setState({ oauthPending: null })));

describe("OAuthButtons", () => {
  it("renders WeChat + Google buttons in Tauri when both flags on", () => {
    isTauriMock.mockReturnValue(true);
    render(<OAuthButtons />);
    // Test env runs zh-CN — assert Chinese labels.
    expect(screen.getByText("使用微信登录")).toBeTruthy();
    expect(screen.getByText("使用 Google 登录")).toBeTruthy();
  });

  it("renders nothing on web (non-Tauri)", () => {
    isTauriMock.mockReturnValue(false);
    const { container } = render(<OAuthButtons />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a cancel control instead of provider buttons while OAuth is pending", () => {
    isTauriMock.mockReturnValue(true);
    const cancelOAuth = vi.fn();
    act(() => useAuthStore.setState({ oauthPending: "google", cancelOAuth }));
    render(<OAuthButtons />);
    // Provider buttons are replaced by the waiting + cancel affordance.
    expect(screen.queryByText("使用 Google 登录")).toBeNull();
    expect(screen.queryByText("使用微信登录")).toBeNull();
    const cancel = screen.getByText("取消并换一种方式");
    fireEvent.click(cancel);
    expect(cancelOAuth).toHaveBeenCalledTimes(1);
  });
});
