import { ApiError } from "../http-utils.js";

const VALID_MODES = new Set(["oss", "managed_git", "custom_git"]);
const VALID_AUTH_KINDS = new Set(["ssh_key", "https_token"]);

function validateShareModeInput(body) {
  const mode = body?.mode;
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
    throw new ApiError(
      400,
      "validation_failed",
      "mode must be one of oss, managed_git, custom_git",
    );
  }
  let gitConfig = null;
  if (mode === "managed_git" || mode === "custom_git") {
    const gc = body.gitConfig ?? {};
    const remoteUrl = typeof gc.remoteUrl === "string" ? gc.remoteUrl.trim() : "";
    if (!remoteUrl) {
      throw new ApiError(
        400,
        "validation_failed",
        "gitConfig.remoteUrl is required for managed_git and custom_git modes",
      );
    }
    gitConfig = { remoteUrl };
    if (mode === "custom_git") {
      const authKind = gc.authKind;
      if (typeof authKind !== "string" || !VALID_AUTH_KINDS.has(authKind)) {
        throw new ApiError(
          400,
          "validation_failed",
          "gitConfig.authKind must be ssh_key or https_token for custom_git",
        );
      }
      const credentialRef =
        typeof gc.credentialRef === "string" ? gc.credentialRef.trim() : "";
      if (!credentialRef) {
        throw new ApiError(
          400,
          "validation_failed",
          "gitConfig.credentialRef is required for custom_git",
        );
      }
      gitConfig.authKind = authKind;
      gitConfig.credentialRef = credentialRef;
    }
  }
  return { mode, gitConfig };
}

function isLockViolation(err) {
  if (!err) return false;
  if (err.code === "check_violation") return true;
  const msg = err.message || "";
  return /locked|already.*share_mode/i.test(msg);
}

export function registerTeamShare(router) {
  router.post("/v1/teams/:teamId/share-mode", async (ctx) => {
    const { mode, gitConfig } = validateShareModeInput(ctx.json ?? {});
    try {
      const team = await ctx.repository.enableShareMode(
        ctx.params.teamId,
        mode,
        gitConfig,
      );
      return { body: team };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isLockViolation(err)) {
        throw new ApiError(
          409,
          "share_mode_locked",
          err.message || "Team share mode is already locked",
          { cause: err },
        );
      }
      throw err;
    }
  });

  router.get("/v1/teams/:teamId/share-mode", async (ctx) => {
    const result = await ctx.repository.getShareMode(ctx.params.teamId);
    return { body: result };
  });

  router.get("/v1/teams/:teamId/workspace-config", async (ctx) => {
    const result = await ctx.repository.getWorkspaceConfig(ctx.params.teamId);
    return { body: result };
  });
}
