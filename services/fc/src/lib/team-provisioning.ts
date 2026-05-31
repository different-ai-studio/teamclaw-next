// services/fc/lib/team-provisioning.mjs
//
// Shared LiteLLM provisioning used by POST /v1/teams. Every team gets a
// LiteLLM team + default key + ai_gateway_endpoint. If LITELLM_MASTER_KEY is
// not configured (local dev, tests), provisioning is skipped and the team is
// created without AI credentials.

const LITELLM_URL = () => process.env.LITELLM_URL || 'https://ai.ucar.cc';
const LITELLM_MASTER_KEY = () => process.env.LITELLM_MASTER_KEY || '';
const AI_GATEWAY_ENDPOINT = () => process.env.AI_GATEWAY_ENDPOINT || (LITELLM_URL() + '/v1');

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

async function litellmFetch(path, method, body) {
  const url = `${LITELLM_URL()}${path}`;
  const opts: any = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_MASTER_KEY()}`,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw Object.assign(new Error(`LiteLLM ${path} → ${res.status}`), { status: res.status, data });
  }
  return data;
}

/**
 * Provision a LiteLLM team + default key for a new TeamClaw team.
 * Returns null when LITELLM_MASTER_KEY is not configured (skip provisioning).
 *
 * @param {string} teamName
 * @returns {Promise<null | { litellmTeamId: string, litellmKey: string, aiGatewayEndpoint: string }>}
 */
export async function provisionTeamLiteLLM(teamName) {
  if (!LITELLM_MASTER_KEY()) {
    console.warn('[team-provisioning] LITELLM_MASTER_KEY not set — skipping LiteLLM provisioning');
    return null;
  }
  const slug = slugify(teamName);
  const teamRes = await litellmFetch('/team/new', 'POST', {
    team_alias: slug,
    max_budget: 1,
    budget_duration: '30d',
  });
  const keyRes = await litellmFetch('/key/generate', 'POST', {
    team_id: teamRes.team_id,
    key_alias: `${slug}-default`,
    max_budget: 0.5,
    budget_duration: '30d',
  });
  return {
    litellmTeamId: teamRes.team_id,
    litellmKey: keyRes.key,
    aiGatewayEndpoint: AI_GATEWAY_ENDPOINT(),
  };
}
