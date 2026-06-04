import type { CloudApiClient } from "./http";

export async function reportDesktopClientVersion(
  client: Pick<CloudApiClient, "post">,
  teamId: string,
  args: { version: string; deviceId: string },
): Promise<void> {
  try {
    await client.post(`/v1/teams/${teamId}/client-version`, {
      clientType: "tauri",
      version: args.version,
      deviceId: args.deviceId,
      build: null,
    });
  } catch {
    // ops telemetry only — never block startup
  }
}
