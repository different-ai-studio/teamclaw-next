import type { TelemetryBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseTelemetryBackend(_client: unknown): TelemetryBackend {
  return {
    insertFeedback: async () => notImplemented("telemetry.insertFeedback"),
    insertSessionReport: async () => notImplemented("telemetry.insertSessionReport"),
    insertTelemetryEvent: async () => notImplemented("telemetry.insertTelemetryEvent"),
  };
}
