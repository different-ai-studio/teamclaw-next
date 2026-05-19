import { describe, expect, it } from "vitest";

describe("auth otp rules", () => {
  it("requires an 8-digit email code before verification", async () => {
    const { OTP_CODE_LENGTH, getOtpValidationError } = await import(
      "../features/onboarding/auth-otp"
    );

    expect(OTP_CODE_LENGTH).toBe(8);
    expect(getOtpValidationError("1234567")).toBe("Enter the 8-digit code from your email.");
    expect(getOtpValidationError("12345678")).toBeNull();
  });

  it("sanitizes pasted values down to numeric 8-digit input", async () => {
    const { OTP_CODE_LENGTH, sanitizeOtpInput } = await import(
      "../features/onboarding/auth-otp"
    );

    expect(sanitizeOtpInput("12a3 4567-89")).toBe("12345678");
    expect(sanitizeOtpInput("1234567890")).toHaveLength(OTP_CODE_LENGTH);
  });
});
