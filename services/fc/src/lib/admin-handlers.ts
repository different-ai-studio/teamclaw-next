import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getS3Client, ACCESS_KEY_ID, ACCESS_KEY_SECRET, OSS_BUCKET as BUCKET, OSS_REGION as REGION, OSS_ENDPOINT as ENDPOINT } from "./oss.js";
import STS20150401, * as $STS from "@alicloud/sts20150401";
import OpenApi, * as $OpenApi from "@alicloud/openapi-client";
import { nanoid } from "nanoid";
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createApnsJwtCache } from './apns-jwt.js';
import { createApnsClient, createHttp2Transport } from './apns.js';
import { dispatchPush } from './push-dispatch.js';
import { createMqttPublisher } from './mqtt-client.js';
import { publishableKeyFromEnv } from './supabase-repo.js';

// ---------------------------------------------------------------------------
// Environment (OSS vars imported from oss.ts; others below)
// ---------------------------------------------------------------------------
const ROLE_ARN = () => process.env.ROLE_ARN;

// LiteLLM proxy
const LITELLM_URL = () => process.env.LITELLM_URL || "https://ai.ucar.cc";
const LITELLM_MASTER_KEY = () => process.env.LITELLM_MASTER_KEY || "";

// CodeUp (Managed Git)
const CODEUP_ORG_ID = () => process.env.CODEUP_ORG_ID || "";
const CODEUP_PAT = () => process.env.CODEUP_PAT || "";
const CODEUP_BOT_USERNAME = () => process.env.CODEUP_BOT_USERNAME || "teamclaw";
const CODEUP_API_BASE = "https://openapi-rdc.aliyuncs.com";

// Push notifications
const PUSH_WEBHOOK_SECRET   = () => process.env.PUSH_WEBHOOK_SECRET || '';
const SUPABASE_URL_FN       = () => process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APNS_PRIVATE_KEY_P8   = () => process.env.APNS_PRIVATE_KEY_P8 || '';
const APNS_KEY_ID           = () => process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID          = () => process.env.APNS_TEAM_ID || '';
const APNS_TOPIC            = () => process.env.APNS_TOPIC || '';
const APNS_ENV              = () => (process.env.APNS_ENV || 'production').toLowerCase();

// MQTT publisher
const MQTT_BROKER_URL       = () => process.env.MQTT_BROKER_URL || '';
const MQTT_USERNAME         = () => process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD         = () => process.env.MQTT_PASSWORD || '';

/** Default team max spend (USD) applied on POST /ai/setup-team → LiteLLM /team/new */
const LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD = () => {
  const raw = process.env.LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function getStsClient() {
  const config = new $OpenApi.Config({
    accessKeyId: ACCESS_KEY_ID(),
    accessKeySecret: ACCESS_KEY_SECRET(),
  });
  config.endpoint = "sts.aliyuncs.com";
  return new STS20150401.default(config);
}

async function ossGet(key: string) {
  const s3 = getS3Client();
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET(), Key: key })
    );
    const text = await (res.Body as { transformToString(): Promise<string> }).transformToString();
    return JSON.parse(text);
  } catch (err: any) {
    if (
      err.name === "NoSuchKey" ||
      err.$metadata?.httpStatusCode === 404 ||
      err.Code === "NoSuchKey"
    ) {
      return null;
    }
    throw err;
  }
}

async function ossPut(key: string, data: unknown) {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    })
  );
}

// ---------------------------------------------------------------------------
// STS policies
// ---------------------------------------------------------------------------
function memberPolicy(teamId: string, nodeId: string) {
  return JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: ["oss:GetObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:ListObjects"],
        Resource: `acs:oss:*:*:${BUCKET()}`,
        Condition: { StringLike: { "oss:Prefix": [`teams/${teamId}/*`] } },
      },
      {
        Effect: "Deny",
        Action: ["oss:GetObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_registry/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/${nodeId}/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/signal/${nodeId}/*`,
      },
    ],
  });
}

function editorPolicy(teamId: string, nodeId: string) {
  const base = JSON.parse(memberPolicy(teamId, nodeId));
  base.Statement.push(
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/generation.json`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    }
  );
  return JSON.stringify(base);
}

function managerPolicy(teamId: string, nodeId: string) {
  const base = JSON.parse(editorPolicy(teamId, nodeId));
  base.Statement.push({
    Effect: "Allow",
    Action: ["oss:PutObject"],
    Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_meta/*`,
  });
  return JSON.stringify(base);
}

function ownerPolicy(teamId: string, nodeId: string) {
  const base = JSON.parse(memberPolicy(teamId, nodeId));
  base.Statement.push(
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_meta/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/generation.json`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
    }
  );
  return JSON.stringify(base);
}

async function assumeRole(sessionName: string, policy: string) {
  const client = getStsClient();
  const request = new $STS.AssumeRoleRequest({
    roleArn: ROLE_ARN(),
    roleSessionName: sessionName,
    durationSeconds: 3600,
    policy,
  });
  const resp = await client.assumeRole(request);
  const creds = resp.body.credentials!;
  return {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    securityToken: creds.securityToken,
    expiration: creds.expiration,
  };
}

function ossInfo() {
  return { bucket: BUCKET(), region: REGION(), endpoint: ENDPOINT() };
}

// ---------------------------------------------------------------------------
// Push dispatch helpers
// ---------------------------------------------------------------------------
let _pushDeps: ReturnType<typeof buildPushDeps> | null = null;
function buildPushDeps() {
  const sbClient = createSupabaseClient(SUPABASE_URL_FN(), SUPABASE_SERVICE_ROLE(), {
    auth: { persistSession: false },
  });
  const sb = {
    rpc: (name: string, args: unknown) => sbClient.rpc(name, args as Record<string, unknown>),
    revokeToken: async (token: string) => {
      await sbClient.from('device_push_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token', token);
    },
  };
  const apnsHost = APNS_ENV() === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const jwt = createApnsJwtCache({
    privateKeyP8: APNS_PRIVATE_KEY_P8(),
    keyId: APNS_KEY_ID(),
    teamId: APNS_TEAM_ID(),
  });
  const apns = createApnsClient({
    jwt, topic: APNS_TOPIC(),
    transport: createHttp2Transport(apnsHost),
  });
  const mqtt = MQTT_BROKER_URL()
    ? createMqttPublisher({
        url: MQTT_BROKER_URL(),
        username: MQTT_USERNAME(),
        password: MQTT_PASSWORD(),
      })
    : null;
  return { sb, apns, mqtt };
}
export function pushDeps() {
  if (_pushDeps) return _pushDeps;
  _pushDeps = buildPushDeps();
  return _pushDeps;
}

// ---------------------------------------------------------------------------
// LiteLLM helpers
// ---------------------------------------------------------------------------
async function litellmFetch(path: string, method: string, body?: unknown) {
  const url = `${LITELLM_URL()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

async function verifyTeam(teamId: string, teamSecret: string, requireOwnerNodeId?: string) {
  if (!teamId || !teamSecret) {
    return { error: json(400, { error: "Missing teamId or teamSecret" }) };
  }
  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return { error: json(404, { error: "Team not found" }) };
  }
  if (sha256(teamSecret) !== auth.teamSecretHash) {
    return { error: json(403, { error: "Invalid team secret" }) };
  }
  if (requireOwnerNodeId && requireOwnerNodeId !== auth.ownerNodeId) {
    return { error: json(403, { error: "Only the owner can perform this action" }) };
  }
  return { auth, isOwner: (nodeId: string) => nodeId === auth.ownerNodeId };
}

// ---------------------------------------------------------------------------
// CodeUp helper
// ---------------------------------------------------------------------------
async function codeupFetch(path: string, method: string, body?: unknown) {
  const url = `${CODEUP_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "x-yunxiao-token": CODEUP_PAT(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
export async function handleRegister(body: any) {
  const { teamSecret, ownerNodeId, teamName, ownerName, ownerEmail } = body;
  if (!teamSecret || !ownerNodeId || !teamName) {
    return json(400, { error: "Missing required fields" });
  }

  const teamId = nanoid();
  const createdAt = new Date().toISOString();
  const teamSecretHash = sha256(teamSecret);

  await ossPut(`teams/${teamId}/_registry/auth.json`, {
    schemaVersion: 1,
    teamSecretHash,
    ownerNodeId,
    createdAt,
  });

  await ossPut(`teams/${teamId}/_meta/team.json`, {
    schemaVersion: 1,
    teamId,
    teamName,
    ownerName,
    ownerEmail,
    ownerNodeId,
    createdAt,
  });

  console.log(`[register] Created team teamId=${teamId} nodeId=${ownerNodeId}`);

  const policy = ownerPolicy(teamId, ownerNodeId);
  const hashedId = createHash("sha256").update(ownerNodeId).digest("hex").slice(0, 16);
  const credentials = await assumeRole(`owner-${hashedId}`, policy);

  return json(200, {
    teamId,
    credentials,
    oss: ossInfo(),
    role: "owner",
  });
}

export async function handleToken(body: any) {
  const { teamId, teamSecret, nodeId } = body;
  if (!teamId || !teamSecret || !nodeId) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(teamSecret) !== auth.teamSecretHash) {
    console.log(`[token] Secret mismatch for teamId=${teamId} nodeId=${nodeId}`);
    return json(403, { error: "Invalid team secret" });
  }

  const isOwner = nodeId === auth.ownerNodeId;
  let role = isOwner ? "owner" : "member";
  let policy = isOwner
    ? ownerPolicy(teamId, nodeId)
    : memberPolicy(teamId, nodeId);

  if (!isOwner) {
    const manifest = await ossGet(`teams/${teamId}/_meta/members.json`);
    if (manifest) {
      const member = manifest.members?.find((m: any) => (m.nodeId ?? m.node_id) === nodeId);
      if (member?.role === "manager") {
        role = member.role;
        policy = managerPolicy(teamId, nodeId);
      } else if (member?.role === "editor") {
        role = member.role;
        policy = editorPolicy(teamId, nodeId);
      }
    }
  }

  const hashedId = createHash("sha256").update(nodeId).digest("hex").slice(0, 16);
  const sessionName = `${role}-${hashedId}`;
  const credentials = await assumeRole(sessionName, policy);

  console.log(`[token] Issued ${role} token for teamId=${teamId} nodeId=${nodeId}`);

  return json(200, { credentials, oss: ossInfo(), role });
}

export async function handleResetSecret(body: any) {
  const { teamId, oldSecret, newSecret, ownerNodeId } = body;
  if (!teamId || !oldSecret || !newSecret || !ownerNodeId) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(oldSecret) !== auth.teamSecretHash) {
    console.log(`[reset-secret] Old secret mismatch for teamId=${teamId}`);
    return json(403, { error: "Invalid old secret" });
  }

  if (ownerNodeId !== auth.ownerNodeId) {
    console.log(`[reset-secret] Owner mismatch for teamId=${teamId}`);
    return json(403, { error: "Only the owner can reset the secret" });
  }

  auth.teamSecretHash = sha256(newSecret);
  await ossPut(`teams/${teamId}/_registry/auth.json`, auth);

  console.log(`[reset-secret] Secret updated for teamId=${teamId}`);
  return json(200, { success: true });
}

export async function handleApply(body: any) {
  const { teamId, teamSecret, nodeId, name, email, note, platform, arch, hostname } = body;
  if (!teamId || !teamSecret || !nodeId || !name || !email) {
    return json(400, { error: "Missing required fields" });
  }

  const auth = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (!auth) {
    return json(404, { error: "Team not found" });
  }

  if (sha256(teamSecret) !== auth.teamSecretHash) {
    console.log(`[apply] Secret mismatch for teamId=${teamId} nodeId=${nodeId}`);
    return json(403, { error: "Invalid team secret" });
  }

  const application = {
    nodeId,
    name,
    email,
    note: note || "",
    platform: platform || "",
    arch: arch || "",
    hostname: hostname || "",
    appliedAt: new Date().toISOString(),
  };

  await ossPut(`teams/${teamId}/_meta/applications/${nodeId}.json`, application);

  console.log(`[apply] Application submitted for teamId=${teamId} nodeId=${nodeId}`);
  return json(200, { success: true });
}

export async function handleAiSetupTeam(body: any) {
  const { teamId, teamSecret, teamName } = body;
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const maxBudget = LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD();
  const res = await litellmFetch("/team/new", "POST", {
    team_id: litellmTeamId,
    team_alias: teamName || teamId,
    max_budget: maxBudget,
  });

  if (!res.ok && res.status !== 409) {
    console.error(`[ai/setup-team] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to create LiteLLM team", detail: res.data });
  }

  console.log(
    `[ai/setup-team] Created LiteLLM team ${litellmTeamId} max_budget_usd=${maxBudget}`
  );
  return json(200, {
    success: true,
    litellmTeamId,
    maxBudgetUsd: maxBudget,
  });
}

export async function handleAiAddMember(body: any) {
  const { teamId, teamSecret, nodeId, memberName } = body;
  if (!nodeId) return json(400, { error: "Missing nodeId" });
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const keyAlias = `${memberName || "member"}-${nodeId.slice(0, 8)}`;
  const keyValue = `sk-tc-${nodeId.slice(0, 40)}`;

  const res = await litellmFetch("/key/generate", "POST", {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: keyAlias,
  });

  if (!res.ok) {
    console.error(`[ai/add-member] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to create LiteLLM key", detail: res.data });
  }

  console.log(`[ai/add-member] Created key for ${nodeId.slice(0, 8)} in team ${litellmTeamId}`);
  return json(200, { success: true, key: keyValue, keyAlias });
}

export async function handleAiRemoveMember(body: any) {
  const { teamId, teamSecret, ownerNodeId, nodeId } = body;
  if (!nodeId) return json(400, { error: "Missing nodeId" });
  const v = await verifyTeam(teamId, teamSecret, ownerNodeId);
  if (v.error) return v.error;

  const keyValue = `sk-tc-${nodeId.slice(0, 40)}`;
  const res = await litellmFetch("/key/delete", "POST", { keys: [keyValue] });

  if (!res.ok) {
    console.error(`[ai/remove-member] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to delete LiteLLM key", detail: res.data });
  }

  console.log(`[ai/remove-member] Deleted key for ${nodeId.slice(0, 8)}`);
  return json(200, { success: true });
}

export async function handleAiKeys(body: any) {
  const { teamId, teamSecret } = body;
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const res = await litellmFetch(`/team/info?team_id=${litellmTeamId}`, "GET");

  if (!res.ok) {
    console.error(`[ai/keys] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to fetch team info", detail: res.data });
  }

  const keys = ((res.data as any).keys || []).map((k: any) => ({
    key: k.token ? `${k.token.slice(0, 10)}...` : "",
    alias: k.key_alias || "",
    spend: k.spend || 0,
    created_at: k.created_at || "",
  }));

  return json(200, { teamId: litellmTeamId, keys });
}

export async function handleAiUsage(body: any) {
  const { teamId, teamSecret, nodeId, startDate, endDate } = body;
  const v = await verifyTeam(teamId, teamSecret);
  if (v.error) return v.error;

  const litellmTeamId = `tc-${teamId}`;
  const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const end = endDate || new Date().toISOString().slice(0, 10);

  if (nodeId) {
    const keyValue = `sk-tc-${nodeId.slice(0, 40)}`;
    const keyRes = await litellmFetch(`/key/info`, "POST", { key: keyValue });

    if (!keyRes.ok) {
      console.error(`[ai/usage] LiteLLM key/info error:`, keyRes.data);
      return json(502, { error: "Failed to fetch key info", detail: keyRes.data });
    }

    const info = (keyRes.data as any).info || keyRes.data;
    return json(200, {
      teamId: litellmTeamId,
      nodeId,
      startDate: start,
      endDate: end,
      spend: info.spend || 0,
      maxBudget: info.max_budget || null,
      keyAlias: info.key_alias || "",
    });
  }

  const teamRes = await litellmFetch(`/team/info?team_id=${litellmTeamId}`, "GET");

  const members: Array<{ alias: string; spend: number }> = [];
  let totalSpend = 0;
  if (teamRes.ok) {
    for (const k of (teamRes.data as any).keys || []) {
      const spend = k.spend || 0;
      totalSpend += spend;
      members.push({
        alias: k.key_alias || "",
        spend,
      });
    }
  }

  return json(200, {
    teamId: litellmTeamId,
    startDate: start,
    endDate: end,
    totalSpend,
    members,
  });
}

export async function handleAiBudget(body: any) {
  const { teamId, teamSecret, ownerNodeId, maxBudget } = body;
  const v = await verifyTeam(teamId, teamSecret, ownerNodeId);
  if (v.error) return v.error;

  if (maxBudget === undefined || maxBudget === null) {
    return json(400, { error: "Missing maxBudget" });
  }

  const litellmTeamId = `tc-${teamId}`;
  const res = await litellmFetch("/team/update", "POST", {
    team_id: litellmTeamId,
    max_budget: Number(maxBudget),
  });

  if (!res.ok) {
    console.error(`[ai/budget] LiteLLM error:`, res.data);
    return json(502, { error: "Failed to update budget", detail: res.data });
  }

  console.log(`[ai/budget] Set budget $${maxBudget} for team ${litellmTeamId}`);
  return json(200, { success: true, maxBudget: Number(maxBudget) });
}

export async function handleManagedGitSetupLitellm(body: any) {
  const { teamId, teamSecret, teamName, ownerNodeId, ownerName } = body;
  if (!teamId || !teamSecret || !ownerNodeId) {
    return json(400, { error: "Missing teamId, teamSecret, or ownerNodeId" });
  }

  const teamSecretHash = sha256(teamSecret);
  const existing = await ossGet(`teams/${teamId}/_registry/auth.json`);
  if (existing) {
    if (existing.teamSecretHash !== teamSecretHash) {
      return json(403, { error: "Team already registered with different secret" });
    }
  } else {
    const createdAt = new Date().toISOString();
    await ossPut(`teams/${teamId}/_registry/auth.json`, {
      schemaVersion: 1,
      teamSecretHash,
      ownerNodeId,
      createdAt,
    });
    await ossPut(`teams/${teamId}/_meta/team.json`, {
      schemaVersion: 1,
      teamId,
      teamName: teamName || teamId,
      ownerName: ownerName || "",
      ownerNodeId,
      createdAt,
    });
    console.log(`[managed-git/setup-litellm] Registered teamId=${teamId} owner=${ownerNodeId.slice(0, 8)}`);
  }

  const litellmTeamId = `tc-${teamId}`;
  const maxBudget = LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD();
  const teamRes = await litellmFetch("/team/new", "POST", {
    team_id: litellmTeamId,
    team_alias: teamName || teamId,
    max_budget: maxBudget,
  });
  if (!teamRes.ok && teamRes.status !== 409) {
    console.error(`[managed-git/setup-litellm] team/new error:`, teamRes.data);
    return json(502, { error: "Failed to create LiteLLM team", detail: teamRes.data });
  }

  const keyAlias = `${ownerName || "owner"}-${ownerNodeId.slice(0, 8)}`;
  const keyValue = `sk-tc-${ownerNodeId.slice(0, 40)}`;
  const keyRes = await litellmFetch("/key/generate", "POST", {
    key: keyValue,
    team_id: litellmTeamId,
    key_alias: keyAlias,
  });
  if (!keyRes.ok) {
    console.error(`[managed-git/setup-litellm] key/generate error:`, keyRes.data);
    return json(502, { error: "Failed to create owner key", detail: keyRes.data });
  }

  console.log(
    `[managed-git/setup-litellm] team=${litellmTeamId} owner=${ownerNodeId.slice(0, 8)} max_budget_usd=${maxBudget}`
  );
  return json(200, {
    success: true,
    litellmTeamId,
    key: keyValue,
    keyAlias,
    maxBudgetUsd: maxBudget,
  });
}

export async function handleManagedGitCreateRepo(body: any) {
  const { teamName } = body;
  if (!teamName) {
    return json(400, { error: "Missing teamName" });
  }

  const orgId = CODEUP_ORG_ID();
  const pat = CODEUP_PAT();
  const botUsername = CODEUP_BOT_USERNAME();
  if (!orgId || !pat) {
    return json(500, { error: "Managed Git not configured (missing CODEUP_ORG_ID or CODEUP_PAT)" });
  }

  const repoName = `tc-${teamName.toLowerCase().replace(/[^a-z0-9一-鿿-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}`;

  const res = await codeupFetch(
    `/oapi/v1/codeup/organizations/${orgId}/repositories`,
    "POST",
    {
      name: repoName,
      path: repoName,
      visibility: "private",
      description: `TeamClaw managed team repo: ${teamName}`,
    }
  );

  if (!res.ok) {
    if (res.status === 409) {
      console.error(`[managed-git] Repo name conflict: ${repoName}`);
      return json(409, { error: "Team name already exists, please choose a different name" });
    }
    console.error(`[managed-git] CodeUp error:`, res.data);
    return json(502, { error: "Failed to create repository", detail: res.data });
  }

  const repoHttpUrl = (res.data as any).httpUrlToRepo;
  console.log(`[managed-git] Created repo ${repoName} → ${repoHttpUrl}`);

  return json(200, {
    repoHttpUrl,
    pat,
    botUsername,
  });
}

export async function handlePushDispatch(headers: Record<string, string> | undefined, body: any) {
  if (headers?.['x-webhook-secret'] !== PUSH_WEBHOOK_SECRET()) {
    return json(401, { error: 'Unauthorized' });
  }
  if (body.type !== 'INSERT' || body.table !== 'messages') {
    return json(200, { skipped: 'not_a_message_insert' });
  }
  try {
    const result = await dispatchPush(body.record, pushDeps());
    return json(200, result);
  } catch (err: any) {
    console.error('[push] dispatch error', err);
    return json(500, { error: String(err.message || err) });
  }
}
