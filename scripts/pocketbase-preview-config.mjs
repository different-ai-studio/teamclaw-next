#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const defaults = JSON.parse(
  fs.readFileSync(path.join(rootDir, "config/services.default.json"), "utf8"),
);

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = {
  ...parseEnvFile(path.join(rootDir, ".env")),
  ...parseEnvFile(path.join(rootDir, ".env.local")),
  ...parseEnvFile(path.join(rootDir, "packages/app/.env.development.local")),
  ...parseEnvFile(path.join(rootDir, "apps/daemon/.env")),
};
const env = { ...fileEnv, ...process.env };

function envValue(...names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function boolValue(value, fallback) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function backupIfChanged(filePath, nextContent) {
  if (!fs.existsSync(filePath)) return;
  const current = fs.readFileSync(filePath, "utf8");
  if (current === nextContent) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  fs.copyFileSync(filePath, `${filePath}.bak-${stamp}`);
}

function writeFileWithBackup(filePath, content) {
  ensureDir(filePath);
  backupIfChanged(filePath, content);
  fs.writeFileSync(filePath, content, "utf8");
}

function mergeEnvFile(filePath, patch) {
  const existing = parseEnvFile(filePath);
  const merged = { ...existing, ...patch };
  const lines = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${String(value)}`);
  writeFileWithBackup(filePath, `${lines.join("\n")}\n`);
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

async function pbRequest(baseUrl, apiPath, options = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${apiPath} failed: HTTP ${response.status} ${text}`);
  }
  return response.json();
}

async function authWithPassword(baseUrl, identity, password) {
  return pbRequest(baseUrl, "/api/collections/accounts/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity, password }),
  });
}

async function firstRecord(baseUrl, collection, filter, token) {
  const query = new URLSearchParams({
    page: "1",
    perPage: "1",
    filter,
  });
  const body = await pbRequest(baseUrl, `/api/collections/${collection}/records?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const record = body.items?.[0];
  if (!record?.id) {
    throw new Error(`No ${collection} record matched filter: ${filter}`);
  }
  return record;
}

function mqttBrokerUrl(host, port, useTls) {
  return `${useTls ? "mqtts" : "mqtt"}://${host}:${port}`;
}

function previewDeviceId(teamId, actorId) {
  const hash = crypto
    .createHash("sha256")
    .update(`${teamId}:${actorId}:pocketbase-preview`)
    .digest("hex")
    .slice(0, 24);
  return `pb-${hash}`;
}

async function main() {
  const pbUrl = normalizeBaseUrl(
    envValue("TEAMCLAW_POCKETBASE_URL", "VITE_POCKETBASE_URL") || "http://127.0.0.1:8090",
  );
  const memberEmail =
    envValue("TEAMCLAW_PB_MEMBER_EMAIL", "VITE_POCKETBASE_PREVIEW_EMAIL") ||
    "preview+member@teamclaw.local";
  const memberPassword =
    envValue("TEAMCLAW_PB_MEMBER_PASSWORD", "VITE_POCKETBASE_PREVIEW_PASSWORD") ||
    "teamclaw-preview";
  const daemonEmail = envValue("TEAMCLAW_PB_DAEMON_EMAIL") || "preview+daemon@teamclaw.local";
  const daemonPassword = envValue("TEAMCLAW_PB_DAEMON_PASSWORD") || memberPassword;

  const mqttHost = envValue("TEAMCLAW_PREVIEW_MQTT_HOST", "VITE_MQTT_HOST") || defaults.mqttHost;
  const mqttPort = Number(envValue("TEAMCLAW_PREVIEW_MQTT_PORT", "VITE_MQTT_PORT") || defaults.mqttPort);
  const mqttUseTls = boolValue(
    envValue("TEAMCLAW_PREVIEW_MQTT_USE_TLS", "VITE_MQTT_USE_TLS"),
    Boolean(defaults.mqttUseTls),
  );
  const mqttUsername = envValue("TEAMCLAW_PREVIEW_MQTT_USERNAME", "VITE_MQTT_USERNAME");
  const mqttPassword = envValue("TEAMCLAW_PREVIEW_MQTT_PASSWORD", "VITE_MQTT_PASSWORD");

  const memberAuth = await authWithPassword(pbUrl, memberEmail, memberPassword);
  const daemonAuth = await authWithPassword(pbUrl, daemonEmail, daemonPassword);

  const team = await firstRecord(pbUrl, "teams", 'slug = "pocketbase-preview"', memberAuth.token);
  const agentActor = await firstRecord(
    pbUrl,
    "actors",
    `team = "${team.id}" && account = "${daemonAuth.record.id}" && actor_type = "agent"`,
    memberAuth.token,
  );

  const desktopConfig = {
    backendKind: "pocketbase",
    pocketbaseUrl: pbUrl,
    mqttHost,
    mqttPort,
    mqttUseTls,
    ...(mqttUsername && mqttPassword
      ? {
          mqttUsername,
          mqttPassword,
        }
      : {}),
  };

  const desktopConfigPath = path.join(os.homedir(), ".teamclaw/config.json");
  writeFileWithBackup(desktopConfigPath, `${JSON.stringify(desktopConfig, null, 2)}\n`);

  const viteEnvPath = path.join(rootDir, "packages/app/.env.development.local");
  mergeEnvFile(viteEnvPath, {
    VITE_BACKEND_KIND: "pocketbase",
    VITE_POCKETBASE_URL: pbUrl,
    VITE_POCKETBASE_PREVIEW_EMAIL: memberEmail,
    VITE_POCKETBASE_PREVIEW_PASSWORD: memberPassword,
    VITE_MQTT_HOST: mqttHost,
    VITE_MQTT_PORT: String(mqttPort),
    VITE_MQTT_USE_TLS: String(mqttUseTls),
    ...(mqttUsername && mqttPassword
      ? {
          VITE_MQTT_USERNAME: mqttUsername,
          VITE_MQTT_PASSWORD: mqttPassword,
        }
      : {}),
  });

  const daemonDir = path.join(os.homedir(), ".amuxd");
  const backendToml = `kind = "pocketbase"

[pocketbase]
url = ${tomlString(pbUrl)}
refresh_token = ${tomlString(daemonAuth.token)}
team_id = ${tomlString(team.id)}
actor_id = ${tomlString(agentActor.id)}
`;
  writeFileWithBackup(path.join(daemonDir, "backend.toml"), backendToml);

  const daemonToml = `team_id = ${tomlString(team.id)}

[device]
id = ${tomlString(previewDeviceId(team.id, agentActor.id))}
name = "PocketBase Preview Daemon"

[mqtt]
broker_url = ${tomlString(mqttBrokerUrl(mqttHost, mqttPort, mqttUseTls))}
${mqttUsername && mqttPassword ? `username = ${tomlString(mqttUsername)}\npassword = ${tomlString(mqttPassword)}\n` : ""}
[agents.codex]
binary = ${tomlString(envValue("TEAMCLAW_CODEX_BIN") || "codex")}
default_flags = []

[agents.claude_code]
binary = ${tomlString(envValue("TEAMCLAW_CLAUDE_BIN") || "claude")}
default_flags = []

[agents.opencode]
binary = ${tomlString(envValue("TEAMCLAW_OPENCODE_BIN") || "opencode")}
default_flags = ["acp"]
`;
  writeFileWithBackup(path.join(daemonDir, "daemon.toml"), daemonToml);

  console.log("PocketBase preview config written.");
  console.log(`  PocketBase: ${pbUrl}`);
  console.log(`  team_id: ${team.id}`);
  console.log(`  agent_actor_id: ${agentActor.id}`);
  console.log(`  desktop config: ${desktopConfigPath}`);
  console.log(`  daemon config: ${path.join(daemonDir, "daemon.toml")}`);
  console.log(`  daemon backend: ${path.join(daemonDir, "backend.toml")}`);
  console.log(`  mqtt: ${mqttBrokerUrl(mqttHost, mqttPort, mqttUseTls)}${mqttUsername ? " (explicit credentials)" : ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
