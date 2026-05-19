export function getOptionalMqttUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_MQTT_URL?.trim();
  return url && url.length > 0 ? url : null;
}
