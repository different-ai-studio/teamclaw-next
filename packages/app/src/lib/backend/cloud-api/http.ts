import type { AuthBackend } from "../types";

export class CloudApiError extends Error {
  status: number;
  code: string;
  requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type CloudApiClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, options?: { idempotencyKey?: string }): Promise<T>;
};

export function createCloudApiClient(args: {
  baseUrl: string;
  auth: Pick<AuthBackend, "getSession">;
  fetchImpl?: typeof fetch;
}): CloudApiClient {
  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const fetchImpl = args.fetchImpl ?? fetch;

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const session = await args.auth.getSession();
    const accessToken = session?.accessToken;
    if (!accessToken) {
      throw new CloudApiError(401, "missing_auth", "Missing auth session access token.", null);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "X-Request-Id": createRequestId(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const error = data?.error;
      throw new CloudApiError(
        response.status,
        typeof error?.code === "string" ? error.code : "internal",
        typeof error?.message === "string" ? error.message : "Cloud API request failed.",
        response.headers.get("X-Request-Id") ?? error?.requestId ?? null,
      );
    }

    return data as T;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body, options) => request("POST", path, body, options),
  };
}

function createRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID().replace(/-/g, "").slice(0, 32);
  return Math.random().toString(36).slice(2).padEnd(12, "0").slice(0, 12);
}
