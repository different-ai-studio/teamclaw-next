// Wired to the project's existing OTP delivery in Plan 4 Task 5.
export async function sendOtpEmail(_args: { email: string; otp: string; type: string }): Promise<void> {
  throw new Error("otp_delivery_not_wired");
}
