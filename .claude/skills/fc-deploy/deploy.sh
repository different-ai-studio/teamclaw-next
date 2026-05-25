#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FC_DIR="$REPO_ROOT/services/fc"

if [ ! -d "$FC_DIR" ]; then
  echo "Error: $FC_DIR does not exist (expected post-monorepo path services/fc)" >&2
  exit 1
fi

# Load root .env first. Its format is mixed — most lines are `KEY VALUE`
# (space-separated, no `=`) which `source` cannot handle, so parse line
# by line. Skip blanks and `#`-comments.
trim_leading_space() {
  local value="${1-}"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "$value"
}

strip_accidental_equals_prefix() {
  local value
  value="$(trim_leading_space "${1-}")"
  if [[ "$value" == =* ]]; then
    value="${value#=}"
    value="$(trim_leading_space "$value")"
  fi
  printf '%s' "$value"
}

if [ -f "$REPO_ROOT/.env" ]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    elif [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+(.+)$ ]]; then
      export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    fi
  done < "$REPO_ROOT/.env"
fi

# .env.local uses standard `KEY=VALUE` and supports the multi-line APNs
# PEM block — let bash handle it natively so the PEM concatenates right.
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env.local"
  set +a
fi

# Optional per-service override (not currently used but kept for parity
# with how other Aliyun fc projects ship a services/fc/.env).
if [ -f "$FC_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$FC_DIR/.env"
  set +a
fi

# Normalize names expected by s.yaml / FC runtime. The repo root .env
# stores Aliyun creds under SRE_ACCESS_KEY_ID (preferred) or SLS_*.
export ACCESS_KEY_ID="$(strip_accidental_equals_prefix "${ACCESS_KEY_ID:-${SRE_ACCESS_KEY_ID:-${SLS_ACCESS_KEY_ID:-}}}")"
export ACCESS_KEY_SECRET="$(strip_accidental_equals_prefix "${ACCESS_KEY_SECRET:-${SRE_ACCESS_KEY_SECRET:-${SLS_ACCESS_KEY_SECRET:-}}}")"
export ROLE_ARN="$(strip_accidental_equals_prefix "${ROLE_ARN:-}")"
export LITELLM_URL="${LITELLM_URL:-${liteLLM_URL:-}}"
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-${liteLLM_MASTER_KEY:-}}"
export LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD="${LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD:-${liteLLM_DEFAULT_TEAM_MAX_BUDGET_USD:-}}"
export CODEUP_ORG_ID="${CODEUP_ORG_ID:-}"
export CODEUP_PAT="${CODEUP_PAT:-}"
export CODEUP_BOT_USERNAME="${CODEUP_BOT_USERNAME:-teamclaw}"

# Required env vars. Grouped so the failure message is informative.
REQUIRED=(
  ACCESS_KEY_ID ACCESS_KEY_SECRET ROLE_ARN
  PUSH_WEBHOOK_SECRET
  SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
  APNS_PRIVATE_KEY_P8 APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC APNS_ENV
  MQTT_BROKER_URL MQTT_USERNAME MQTT_PASSWORD
)
missing=()
for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Error: missing required env vars:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Set them in $REPO_ROOT/.env.local (preferred) or $REPO_ROOT/.env." >&2
  exit 1
fi

cd "$FC_DIR"

# Check s CLI
if ! command -v s &>/dev/null; then
  echo "Installing Serverless Devs..."
  npm install -g @serverless-devs/s
fi

# Install dependencies (avoid broken third-party npm mirrors)
export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"
npm install --omit=dev

# Deploy
printf 'yes\n' | s deploy -y
