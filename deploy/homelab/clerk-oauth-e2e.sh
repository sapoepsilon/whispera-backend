#!/usr/bin/env bash
# Clerk PRODUCTION OAuth public-client PKCE e2e (what the iOS/macOS apps do, minus the browser): throwaway user -> sign-in token -> FAPI ticket sign-in (cookie jar)
# -> /oauth/authorize (S256) -> code on custom-scheme redirect -> /oauth/token (no secret) -> verify id_token claims
# -> refresh_token grant -> call hosted backend with id_token -> delete user. Prints no tokens.
# Usage: CID=<client id> [REDIR=whispera://auth/callback|whispera-mac://auth/callback] [BASE=https://api.mansurov.dev] clerk-oauth-e2e.sh
set -euo pipefail
A=app_3Gyfg2CgagmoLHkDapM5goAg4gc; CID=${CID:?}; REDIR=${REDIR:-whispera://auth/callback}; BASE=${BASE:-https://api.mansurov.dev}
FAPI=https://clerk.whispera.mansurov.dev
CK() { clerk api "$@" --app $A --instance prod --mode agent --yes </dev/null; }
J=$(mktemp -d); trap 'rm -rf $J' EXIT
claims() { cut -d. -f2 <<<"$1" | tr _- /+ | awk '{l=length($0)%4; if(l==2)$0=$0"=="; else if(l==3)$0=$0"="; print}' | base64 -d 2>/dev/null; }
RND=$(openssl rand -hex 4)
UID_=$(CK /users -X POST -d "{\"email_address\":[\"whispera-oauth-test+$RND@mansurov.dev\"],\"skip_password_requirement\":true,\"username\":\"oauthtest$RND\"}" | jq -r .id)
echo "test user: $UID_"
trap 'CK /users/$UID_ -X DELETE | jq -c "{deleted,id}"; rm -rf $J' EXIT
TK=$(CK /sign_in_tokens -X POST -d "{\"user_id\":\"$UID_\",\"expires_in_seconds\":120}" | jq -r .token)
curl -sS -c $J/c -b $J/c "$FAPI/v1/client" -H "Origin: https://whispera.mansurov.dev" -o /dev/null
SI=$(curl -sS -c $J/c -b $J/c -X POST "$FAPI/v1/client/sign_ins" -H "Origin: https://whispera.mansurov.dev" --data-urlencode strategy=ticket --data-urlencode "ticket=$TK"); unset TK
echo "sign-in: $(jq -c '{status:.response.status, err:.errors[0].code}' <<<"$SI")"
VER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CH=$(printf %s "$VER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
ST=$(openssl rand -hex 8); NONCE=$(openssl rand -hex 8)
LOC=$(curl -sS -b $J/c -c $J/c -o $J/authz.html -w '%{http_code} %{redirect_url}' -G "$FAPI/oauth/authorize" \
  --data-urlencode response_type=code --data-urlencode client_id=$CID --data-urlencode "redirect_uri=$REDIR" \
  --data-urlencode "scope=openid profile email offline_access" --data-urlencode state=$ST --data-urlencode nonce=$NONCE \
  --data-urlencode code_challenge=$CH --data-urlencode code_challenge_method=S256)
echo "authorize: HTTP ${LOC%% *} -> $(sed -E 's/code=[^&]+/code=<redacted>/' <<<"${LOC#* }")"
CODE=$(sed -nE 's/.*[?&]code=([^&]+).*/\1/p' <<<"$LOC"); RST=$(sed -nE 's/.*[?&]state=([^&]+).*/\1/p' <<<"$LOC")
[ -n "$CODE" ] || { echo "no code; body head:"; head -c 400 $J/authz.html; echo; exit 1; }
echo "state matches: $([ "$RST" = "$ST" ] && echo yes || echo NO)"
TOK=$(curl -sS -X POST "$FAPI/oauth/token" -H accept:application/json --data-urlencode grant_type=authorization_code \
  --data-urlencode "code=$CODE" --data-urlencode "redirect_uri=$REDIR" --data-urlencode client_id=$CID --data-urlencode "code_verifier=$VER")
echo "token response keys: $(jq -c 'keys' <<<"$TOK") token_type=$(jq -r .token_type <<<"$TOK") expires_in=$(jq -r .expires_in <<<"$TOK") scope=$(jq -r .scope <<<"$TOK") err=$(jq -r '.error // empty' <<<"$TOK")"
IDT=$(jq -r '.id_token // empty' <<<"$TOK"); AT=$(jq -r '.access_token // empty' <<<"$TOK"); RT=$(jq -r '.refresh_token // empty' <<<"$TOK"); unset TOK
echo "id_token claims: $(claims "$IDT" | jq -c --arg n $NONCE '{iss,aud,azp,sub,nonce_ok:(.nonce==$n),exp_in:(.exp-now|floor)}')"
echo "access_token: $(awk -F. '{print (NF==3 ? "JWT" : "opaque")}' <<<"$AT") $( [ "$(awk -F. '{print NF}' <<<"$AT")" = 3 ] && claims "$AT" | jq -c '{iss,aud,azp,sub,client_id,exp_in:(.exp-now|floor)}')"
echo "refresh_token present: $([ -n "$RT" ] && echo yes || echo no)"
echo "== backend GET /v1/devices with id_token"; curl -sS -o /dev/null -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $IDT" "$BASE/v1/devices"
echo "== backend GET /v1/devices with access_token"; curl -sS -o /dev/null -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $AT" "$BASE/v1/devices"
openssl ecparam -name prime256v1 -genkey -noout -out $J/k.pem 2>/dev/null
PUB=$(openssl ec -in $J/k.pem -pubout -outform DER 2>/dev/null | tail -c 65 | base64)
R=$(curl -sS -X POST -w '\n%{http_code}' -H "Authorization: Bearer $IDT" -H content-type:application/json --data-binary "{\"name\":\"oauth-test-$RND\",\"platform\":\"ios\",\"link_pubkey\":\"$PUB\"}" "$BASE/v1/devices")
DID=$(head -1 <<<"$R" | jq -r '.device_id // empty'); echo "== POST /v1/devices with id_token: HTTP $(tail -1 <<<"$R") device=$DID"
[ -n "$DID" ] && curl -sS -o /dev/null -w "== DELETE /v1/devices/$DID: HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $IDT" "$BASE/v1/devices/$DID"
echo "== wrong verifier is rejected (replay code)"; curl -sS -X POST "$FAPI/oauth/token" --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "redirect_uri=$REDIR" --data-urlencode client_id=$CID --data-urlencode "code_verifier=wrong$VER" | jq -c '{error}'
if [ -n "$RT" ]; then
  R2=$(curl -sS -X POST "$FAPI/oauth/token" --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$RT" --data-urlencode client_id=$CID)
  echo "refresh: keys=$(jq -c keys <<<"$R2") err=$(jq -r '.error // empty' <<<"$R2") rotated=$([ "$(jq -r .refresh_token <<<"$R2")" != "$RT" ] && echo yes || echo no)"
  I2=$(jq -r '.id_token // empty' <<<"$R2"); [ -n "$I2" ] && echo "refreshed id_token: $(claims "$I2" | jq -c '{aud,sub,exp_in:(.exp-now|floor)}')" && \
    curl -sS -o /dev/null -w 'backend with refreshed id_token: HTTP %{http_code}\n' -H "Authorization: Bearer $I2" "$BASE/v1/devices"
  unset R2 I2
fi
unset IDT AT RT CODE VER
