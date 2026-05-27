import { ApiError } from "../http-utils.mjs";

export function registerAttachments(router) {
  router.postRaw("/v1/attachments", async (ctx) => {
    const path = ctx.query.get("path");
    if (!path) throw new ApiError(400, "invalid_request", "path query parameter is required");
    const mime = ctx.headers["content-type"] ?? "application/octet-stream";
    const out = await ctx.repository.uploadAttachment({ path, mime, bytes: ctx.rawBody });
    return { statusCode: 200, body: out };
  });

  router.get("/v1/attachments/:path", async (ctx) => {
    const out = await ctx.repository.downloadAttachment(ctx.params.path);
    if (!out) throw new ApiError(404, "not_found", "attachment not found");
    return { binary: { mime: out.mime, bytes: out.bytes } };
  });
}
