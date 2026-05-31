import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const defaultBaseURL = () => process.env.AUTH_BASE_URL ?? "https://cloud.ucar.cc";
let _remote: ReturnType<typeof createRemoteJWKSet> | null = null;
function remoteJwks(baseURL: string) {
  if (!_remote) _remote = createRemoteJWKSet(new URL(`${baseURL}/api/auth/jwks`));
  return _remote;
}

export type VerifiedClaims = { sub: string; [k: string]: unknown };

// Verify a Better-Auth-issued JWT and return claims (sub = user id).
// `opts.keyset` lets tests inject a local JWKS; production uses the remote JWKS.
export async function verifyAccessToken(
  token: string,
  opts: { keyset?: JWTVerifyGetKey; baseURL?: string } = {},
): Promise<VerifiedClaims> {
  const baseURL = opts.baseURL ?? defaultBaseURL();
  const keyset = opts.keyset ?? remoteJwks(baseURL);
  const { payload } = await jwtVerify(token, keyset, { issuer: baseURL, audience: baseURL });
  if (!payload.sub) throw new Error("jwt_missing_sub");
  return payload as VerifiedClaims;
}
