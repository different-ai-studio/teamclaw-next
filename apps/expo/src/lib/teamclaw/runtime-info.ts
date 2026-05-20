import type { RuntimeInfo } from "../../features/actors/connected-agent-types";

/**
 * Placeholder runtime info decoder. The `Amux_RuntimeInfo` proto schema
 * hasn't been exported for Expo consumption yet — this is a known TODO
 * gated on the proto generation step. Returns null so subscribers do not
 * crash on malformed payloads. Replace with `fromBinary(RuntimeInfoSchema, payload)`
 * once the schema is available.
 */
export function decodeRuntimeInfo(_payload: Uint8Array): RuntimeInfo | null {
  return null;
}
