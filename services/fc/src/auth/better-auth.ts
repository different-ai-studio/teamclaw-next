import { betterAuth } from "better-auth";
import { jwt, bearer, anonymous, emailOTP, genericOAuth } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "../db/client.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as schema from "../db/schema/index.js";
import { sendOtpEmail } from "./otp-delivery.js";

let _auth: ReturnType<typeof build> | null = null;

function build() {
  const baseURL = process.env.AUTH_BASE_URL ?? "https://cloud.ucar.cc";
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return betterAuth({
    baseURL,
    secret,
    // schema cast to any: Better-Auth tables (user, session, account, etc.)
    // are added to schema in Task 2. Until then this avoids a type error.
    database: drizzleAdapter(getDb(), { provider: "pg", schema: schema as any }),
    emailAndPassword: { enabled: true },
    socialProviders: {
      apple: { clientId: process.env.APPLE_CLIENT_ID ?? "", clientSecret: process.env.APPLE_CLIENT_SECRET ?? "" },
      google: { clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" },
    },
    plugins: [
      jwt(),
      bearer(),
      anonymous(),
      emailOTP({ sendVerificationOTP: sendOtpEmail }),
      genericOAuth({ config: [] }),
    ],
  });
}

// Lazy singleton: importing this module needs no env until getAuth() is called.
export function getAuth() {
  if (!_auth) _auth = build();
  return _auth;
}
export type Auth = ReturnType<typeof build>;
