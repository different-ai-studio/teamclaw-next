import { ApiError } from "../http-utils.mjs";
import { requireString } from "../router.mjs";

export function registerShortcuts(router) {
  router.get("/v1/teams/:teamId/shortcuts", async (ctx) => {
    const { teamId } = ctx.params;
    const args = {};
    const parentIdRaw = ctx.query.get("parentId");
    if (parentIdRaw !== null && parentIdRaw !== undefined) {
      args.parentId = parentIdRaw === "null" ? null : parentIdRaw;
    }
    const items = await ctx.repository.listShortcuts(teamId, args);
    return { body: { items } };
  });

  router.post("/v1/shortcuts", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.kind, "kind");
    requireString(body.label, "label");
    const shortcut = await ctx.repository.createShortcut(body);
    return { statusCode: 201, body: shortcut };
  });

  router.patch("/v1/shortcuts/:shortcutId", async (ctx) => {
    const shortcut = await ctx.repository.updateShortcut(ctx.params.shortcutId, ctx.json ?? {});
    if (!shortcut) throw new ApiError(404, "not_found", "shortcut not found");
    return { body: shortcut };
  });

  router.delete("/v1/shortcuts/:shortcutId", async (ctx) => {
    await ctx.repository.deleteShortcut(ctx.params.shortcutId);
    return { statusCode: 204, body: null };
  });

  router.post("/v1/shortcuts/batch-move", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.moves)) {
      throw new ApiError(400, "validation_failed", "moves is required and must be an array");
    }
    await ctx.repository.batchMoveShortcuts({ moves: body.moves });
    return { statusCode: 204, body: null };
  });

  router.put("/v1/shortcuts/:shortcutId/visible-roles", async (ctx) => {
    const body = ctx.json ?? {};
    if (!Array.isArray(body.roleIds)) {
      throw new ApiError(400, "validation_failed", "roleIds is required and must be an array");
    }
    await ctx.repository.setShortcutVisibleRoles(ctx.params.shortcutId, { roleIds: body.roleIds });
    return { statusCode: 204, body: null };
  });

  router.get("/v1/teams/:teamId/roles", async (ctx) => {
    const items = await ctx.repository.listTeamRoles(ctx.params.teamId);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/permissions", async (ctx) => {
    const items = await ctx.repository.listTeamPermissions(ctx.params.teamId);
    return { body: { items } };
  });

  router.get("/v1/teams/:teamId/shortcut-role-bindings", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const items = await ctx.repository.listShortcutRoleBindings(teamId);
    return { body: { items } };
  });
}
