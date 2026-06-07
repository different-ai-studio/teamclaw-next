import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
