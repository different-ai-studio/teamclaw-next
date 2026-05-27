import {
  ApiError,
  errorResponse,
  extractBearerToken,
  jsonResponse,
  resolveRequestId,
} from "./http-utils.mjs";
import { createRouter, normalizePath } from "./router.mjs";
import { registerAllRoutes } from "./routes/index.mjs";

export async function handleBusinessApiRequest(event, deps) {
  const requestId = resolveRequestId(event.headers);
  try {
    const method = event.httpMethod || event.requestContext?.http?.method || "GET";
    const path = normalizePath(event.path || event.rawPath || "/");
    const token = extractBearerToken(event.headers);
    const repository = deps.createRepository({ accessToken: token });
    const router = createRouter({ repository });
    registerAllRoutes(router);
    const result = await router.dispatch({ method, path, event });
    if (!result) {
      throw new ApiError(404, "not_found", "Route not found");
    }
    return jsonResponse(result.statusCode ?? 200, result.body, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export { encodeCursor, decodeCursor } from "./router.mjs";