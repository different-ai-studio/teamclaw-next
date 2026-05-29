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

    const router = createRouter({ repository: null });
    registerAllRoutes(router);

    const routeCheck = router.checkRoute({ method, path });
    if (!routeCheck) {
      throw new ApiError(404, "not_found", "Route not found");
    }

    const requiresAuth = routeCheck.authRequired;
    const token = requiresAuth ? extractBearerToken(event.headers) : null;
    const repository = requiresAuth 
      ? deps.createRepository({ accessToken: token })
      : deps.createAuthRepository();

    const result = await router.dispatchWithRepository({ method, path, event, repository });
    if (result.binary) {
      return {
        statusCode: result.statusCode ?? 200,
        headers: {
          "Content-Type": result.binary.mime,
          "X-Request-Id": requestId,
        },
        body: result.binary.bytes.toString("base64"),
        isBase64Encoded: true,
      };
    }
    if (result.redirect) {
      return {
        statusCode: 302,
        headers: {
          "Location": result.redirect,
          "X-Request-Id": requestId,
        },
        body: "",
      };
    }
    return jsonResponse(result.statusCode ?? 200, result.body, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export { encodeCursor, decodeCursor } from "./router.mjs";