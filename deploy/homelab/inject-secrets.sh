#!/usr/bin/env bash
# Run on a Mac wired to the bws-touchid gate (skill bws-touchid-save). ONE Touch ID:
# a single `bws-gated secret list` read of project hermes-personal. It then
#   1. creates (or reuses) the remotely-managed Cloudflare Tunnel "whispera-api",
#      sets its ingress to api.mansurov.dev -> http://127.0.0.1:8080 and a proxied CNAME,
#   2. writes into the LXC: /etc/cloudflared/tunnel.env (TUNNEL_TOKEN, 0600 root),
#      /etc/whispera/apns.p8 (0600 whispera) and the APNs ids into /etc/whispera/whispera.env.
# No secret value is printed, written to the Mac's disk, or passed in argv.
# Usage: inject-secrets.sh [pve-host] [ctid]
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
PVE=${1:-root@192.168.50.129}
CT=${2:-158}
PROJECT=${BWS_PROJECT_ID:-a186263a-9ab4-46cf-927f-b4b700279cb8}   # hermes-personal
HOST=api.mansurov.dev
ZONE_NAME=mansurov.dev
TUNNEL_NAME=whispera-api
SERVICE=http://127.0.0.1:8080

echo "reading BWS (one Touch ID)..."
SECRETS=$(bws-gated secret list "$PROJECT" -o json)
get() { jq -er --arg k "$1" '[.[] | select(.key == $k)][0].value' <<<"$SECRETS" || { echo "missing secret $1" >&2; return 1; }; }
CF_TOKEN=$(get CLOUDFLARE_API_TOKEN)
CF_ACCOUNT=$(get CLOUDFLARE_ACCOUNT_ID)
CF_ZONE=$(get CLOUDFLARE_ZONE_ID_MANSUROV_DEV)
APNS_P8_B64=$(get APNS_AUTH_KEY_P8_B64)
APNS_KEY_ID=$(get APNS_KEY_ID)
APNS_TEAM_ID=$(get APNS_TEAM_ID)
unset SECRETS
echo "secrets present"

cf() { # cf METHOD PATH [JSON]; prints the response body
  local args=(-sS -X "$1" "https://api.cloudflare.com/client/v4$2" -H "Content-Type: application/json")
  [ $# -ge 3 ] && args+=(--data "$3")
  curl "${args[@]}" -K - <<<"header = \"Authorization: Bearer $CF_TOKEN\""
}
ok() { jq -e '.success == true' >/dev/null <<<"$1" || { echo "cloudflare error: $(jq -c '.errors' <<<"$1")" >&2; exit 1; }; }

R=$(cf GET "/zones/$CF_ZONE"); ok "$R"
[ "$(jq -r '.result.name' <<<"$R")" = "$ZONE_NAME" ] || { echo "zone id is not $ZONE_NAME; refusing" >&2; exit 1; }

R=$(cf GET "/accounts/$CF_ACCOUNT/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false"); ok "$R"
TID=$(jq -r '.result[0].id // empty' <<<"$R")
if [ -z "$TID" ]; then
  R=$(cf POST "/accounts/$CF_ACCOUNT/cfd_tunnel" "{\"name\":\"$TUNNEL_NAME\",\"config_src\":\"cloudflare\"}"); ok "$R"
  TID=$(jq -r '.result.id' <<<"$R"); echo "created tunnel $TID"
else
  echo "reusing tunnel $TID"
fi

R=$(cf PUT "/accounts/$CF_ACCOUNT/cfd_tunnel/$TID/configurations" \
  "{\"config\":{\"ingress\":[{\"hostname\":\"$HOST\",\"service\":\"$SERVICE\"},{\"service\":\"http_status:404\"}]}}"); ok "$R"
echo "ingress set: $HOST -> $SERVICE"

TARGET="$TID.cfargotunnel.com"
R=$(cf GET "/zones/$CF_ZONE/dns_records?name=$HOST"); ok "$R"
EXIST=$(jq -r '.result[0] | select(.) | "\(.type) \(.content)"' <<<"$R")
if [ -z "$EXIST" ]; then
  R=$(cf POST "/zones/$CF_ZONE/dns_records" \
    "{\"type\":\"CNAME\",\"name\":\"$HOST\",\"content\":\"$TARGET\",\"proxied\":true,\"comment\":\"whispera-api tunnel (CT$CT)\"}"); ok "$R"
  echo "dns: CNAME $HOST -> $TARGET (proxied)"
elif [ "$EXIST" = "CNAME $TARGET" ]; then
  echo "dns: already CNAME $HOST -> $TARGET"
else
  echo "dns: $HOST already exists as '$EXIST'; refusing to overwrite" >&2; exit 1
fi

R=$(cf GET "/accounts/$CF_ACCOUNT/cfd_tunnel/$TID/token"); ok "$R"
TUNNEL_TOKEN=$(jq -r '.result' <<<"$R"); unset R

ctw() { # ctw PATH MODE OWNER ; stdin -> file in the CT
  ssh -o BatchMode=yes "$PVE" "pct exec $CT -- sh -c 'umask 077; cat > \"$1.tmp\" && chown $3 \"$1.tmp\" && chmod $2 \"$1.tmp\" && mv \"$1.tmp\" \"$1\"'"
}
printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" | ctw /etc/cloudflared/tunnel.env 0600 root:root
base64 -d <<<"$APNS_P8_B64" | ctw /etc/whispera/apns.p8 0600 whispera:whispera
# APNs key/team ids are identifiers, not secrets, but still never echoed here.
printf '%s\n%s\n' "$APNS_KEY_ID" "$APNS_TEAM_ID" | ssh -o BatchMode=yes "$PVE" \
  "pct exec $CT -- sh -c 'read -r K; read -r T; sed -i -e \"s/^APNS_KEY_ID=.*/APNS_KEY_ID=\$K/\" -e \"s/^APNS_TEAM_ID=.*/APNS_TEAM_ID=\$T/\" /etc/whispera/whispera.env'"
unset CF_TOKEN TUNNEL_TOKEN APNS_P8_B64
echo "injected into CT$CT: tunnel.env, apns.p8, APNs ids (tunnel $TID)"
