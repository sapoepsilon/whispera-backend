#!/usr/bin/env bash
# Clerk PRODUCTION end-to-end check: throwaway user -> sign-in token -> native FAPI ticket sign-in
# -> "whispera" JWT template token -> POST/GET/DELETE /v1/devices -> revoke session, delete user.
# Uses the logged-in `clerk` CLI (platform auth); prints no secrets. JWT stays in memory.
# Usage: clerk-e2e.sh BASE_URL local|ct   (ct = curl from inside CT158 via ssh+pct)
set -euo pipefail
BASE=$1; RUNNER=$2
A=app_3Gyfg2CgagmoLHkDapM5goAg4gc
CK() { clerk api "$@" --app $A --instance prod --mode agent --yes; }
FAPI=https://clerk.whispera.mansurov.dev
SP=$(mktemp -d)
call() { # call METHOD PATH [BODY]; JWT on stdin line 1
  if [ "$RUNNER" = ct ]; then
    ssh root@192.168.50.129 "pct exec 158 -- bash -c 'read -r J; curl -sS -X $1 -w \"\\nHTTP %{http_code}\\n\" -H \"Authorization: Bearer \$J\" -H content-type:application/json ${3:+--data-binary @/root/body.json} $BASE$2'"
  else
    read -r J; curl -sS -X "$1" -w "\nHTTP %{http_code}\n" -H "Authorization: Bearer $J" -H content-type:application/json ${3:+--data-binary "$3"} "$BASE$2"
  fi
}
RND=$(openssl rand -hex 4)
U=$(CK /users -X POST -d "{\"email_address\":[\"whispera-deploy-test+$RND@mansurov.dev\"],\"skip_password_requirement\":true,\"username\":\"deploytest$RND\"}")
UID_=$(jq -r .id <<<"$U"); echo "test user: $UID_"
cleanup() { CK /users/$UID_ -X DELETE | jq -c '{deleted,id}'; }
trap cleanup EXIT
TK=$(CK /sign_in_tokens -X POST -d "{\"user_id\":\"$UID_\",\"expires_in_seconds\":120}" | jq -r .token)
SI=$(curl -sS -X POST "$FAPI/v1/client/sign_ins?_is_native=true" --data-urlencode strategy=ticket --data-urlencode "ticket=$TK")
SID=$(jq -r '.response.created_session_id // .client.last_active_session_id' <<<"$SI"); unset TK
echo "sign-in status: $(jq -r .response.status <<<"$SI"), session: $SID"
JWT=$(CK /sessions/$SID/tokens/whispera -X POST | jq -r .jwt)
echo "jwt claims: $(cut -d. -f2 <<<"$JWT" | tr _- /+ | base64 -d 2>/dev/null | jq -c '{iss,aud,azp,sub}' 2>/dev/null || echo '(decode pad)')"
openssl ecparam -name prime256v1 -genkey -noout -out $SP/link.pem 2>/dev/null
PUB=$(openssl ec -in $SP/link.pem -pubout -outform DER 2>/dev/null | tail -c 65 | base64); rm -f $SP/link.pem
BODY="{\"name\":\"deploy-test-$RND\",\"platform\":\"ios\",\"link_pubkey\":\"$PUB\",\"apns\":{\"token\":\"$(openssl rand -hex 32)\",\"env\":\"sandbox\"}}"
[ "$RUNNER" = ct ] && printf %s "$BODY" | ssh root@192.168.50.129 "pct exec 158 -- sh -c 'cat > /root/body.json'"
echo "== POST /v1/devices"; R=$(echo "$JWT" | call POST /v1/devices "$BODY"); echo "$R"
DID=$(head -1 <<<"$R" | jq -r .device_id)
echo "== GET /v1/devices"; echo "$JWT" | call GET /v1/devices | sed 's/"link_pubkey":"[^"]*"/"link_pubkey":"…"/g'
echo "== DELETE /v1/devices/$DID"; echo "$JWT" | call DELETE /v1/devices/$DID
echo "== GET /v1/devices (after revoke)"; echo "$JWT" | call GET /v1/devices | head -1 | jq -c '.devices[]? | {device_id,revoked_at}' 2>/dev/null || true
echo "== revoke session"; CK /sessions/$SID/revoke -X POST | jq -c '{id,status}'
unset JWT
